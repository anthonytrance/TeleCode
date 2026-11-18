"""Reproducible Windows pure-Go GOWA build with bounded-memory document transfers.

The stock binary remains available. This writes whatsapp-telecode.exe beside it.
All downloads and module/build caches stay inside the private state directory.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile
from curl_cffi import requests

COMMIT = "be8e3a252f3d091ec86effb23adc0e0c99c9a561"
SOURCE_SHA = "a005e06d2de59827a22d08cb51d6672fa13088a15f9c1913cf2bc78376ad15d7"
GO_VERSION = "1.27.4"
GO_SHA = "178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e"


def extract(url, digest, directory):
    response = requests.get(url, impersonate="chrome124", timeout=180)
    response.raise_for_status()
    if hashlib.sha256(response.content).hexdigest() != digest:
        raise RuntimeError("Downloaded archive checksum mismatch")
    directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        for item in archive.infolist():
            if not (directory / item.filename).resolve().is_relative_to(directory.resolve()):
                raise RuntimeError("Unsafe archive member")
        archive.extractall(directory)


def replace(file, old, new):
    text = file.read_text(encoding="utf-8")
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f"Pinned source no longer matches patch: {file.name}")
    file.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--output", type=Path, help="Stage a new executable while the current one is running")
    args = parser.parse_args()
    state = args.directory.resolve()
    build = state / "build"
    go = build / "go" / "go" / "bin" / "go.exe"
    source = build / "source" / f"go-whatsapp-web-multidevice-{COMMIT}" / "src"
    if not go.exists():
        extract(f"https://go.dev/dl/go{GO_VERSION}.windows-amd64.zip", GO_SHA, build / "go")
    if not source.exists():
        extract(f"https://codeload.github.com/aldinokemal/go-whatsapp-web-multidevice/zip/{COMMIT}", SOURCE_SHA, build / "source")
    dto = source / "domains" / "send" / "file.go"
    replace(dto, "type FileRequest struct {", 'type FileRequest struct {\n\tLocalFile *string `json:"local_file,omitempty" form:"local_file"`\n\tLocalSHA256 string `json:"local_sha256,omitempty" form:"local_sha256"`')
    validation = source / "validations" / "send_validation.go"
    replace(validation, 'if request.File == nil && (request.FileURL == nil || *request.FileURL == "") {', 'if request.LocalFile != nil {\n\t\tif request.File != nil || request.FileURL != nil || request.IsScheduled() || len(request.LocalSHA256) != 64 {\n\t\t\treturn pkgError.ValidationError("Local document requires an exact digest and immediate delivery")\n\t\t}\n\t}\n\tif request.LocalFile == nil && request.File == nil && (request.FileURL == nil || *request.FileURL == "") {')
    send = source / "usecase" / "send.go"
    # Limit the insertion to SendFile so other native media handlers remain untouched.
    text = send.read_text(encoding="utf-8")
    start = text.index("func (service serviceSend) SendFile(")
    end = text.index("\n// generateDocumentThumbnail", start)
    portion = text[start:end]
    marker = "\tvar (\n\t\tfileBytes []byte"
    insertion = '\tif request.LocalFile != nil {\n\t\treturn service.sendTelecodeDocument(ctx, client, dataWaRecipient, request)\n\t}\n\n' + marker
    if insertion not in portion:
        if portion.count(marker) != 1: raise RuntimeError("SendFile source mismatch")
        text = text[:start] + portion.replace(marker, insertion) + text[end:]
        send.write_text(text, encoding="utf-8", newline="\n")
    settings = source / "config" / "settings.go"
    settings_text = settings.read_text(encoding="utf-8").replace('AppVersion             = "v9.9.0-telecode.1"', 'AppVersion             = "v9.9.0"')
    settings.write_text(settings_text, encoding="utf-8", newline="\n")
    settings_text = settings.read_text(encoding="utf-8").replace('AppVersion             = "v9.9.0-telecode.2"', 'AppVersion             = "v9.9.0"')
    settings.write_text(settings_text, encoding="utf-8", newline="\n")
    replace(settings, 'AppVersion             = "v9.9.0"', 'AppVersion             = "v9.9.0-telecode.3"')
    app = source / "usecase" / "app.go"
    replace(app, '\t// Connect before requesting pairing code.\n\tif !client.IsConnected() {\n\t\tif err = client.Connect(); err != nil {\n\t\t\treturn loginCode, err\n\t\t}\n\t}', '\t// Establish a fresh, QR-ready socket before requesting a phone code.\n\tif err = prepareTelecodePhonePairing(ctx, client); err != nil {\n\t\treturn loginCode, err\n\t}')
    replace(app, 'logrus.Infof("Successfully paired phone with code: %s", loginCode)', 'logrus.Info("Phone-linking code generated; awaiting confirmation on the phone")')
    # The local-file route enforces its own 2 GB cap and streams via disk. Retain
    # the stock multipart request body cap so a giant HTTP body is not buffered.
    replace(settings, 'WhatsappSettingMaxDownloadSize    int64    = 500000000 // 500MB', 'WhatsappSettingMaxDownloadSize    int64    = 2000000000 // TeleCode document limit')
    timeout = source / "ui" / "rest" / "middleware" / "timeout.go"
    replace(timeout, '"context"\n', '"context"\n\t"strings"\n')
    replace(timeout, 'ctx, cancel := context.WithTimeout(c.Context(), timeout)', 'effective := timeout\n\t\tif strings.HasSuffix(c.Path(), "/send/file") || (strings.Contains(c.Path(), "/message/") && strings.HasSuffix(c.Path(), "/download")) { effective = 20 * time.Minute }\n\t\tctx, cancel := context.WithTimeout(c.Context(), effective)')
    replace(timeout, '\t\tc.SetContext(ctx)', '\t\tpinned, err := telecodeMessageContext(ctx, c.Get("X-Telecode-Message-Id"))\n\t\tif err != nil { return fiber.NewError(400, err.Error()) }\n\t\tc.SetContext(pinned)')
    resources = Path(__file__).resolve().parent / "whatsapp-gowa"
    for name in ["telecode_document.go", "telecode_document_test.go", "telecode_pairing.go", "telecode_pairing_test.go"]:
        shutil.copyfile(resources / name, source / "usecase" / name)
    for name in ["telecode_download.go", "telecode_download_test.go"]:
        shutil.copyfile(resources / name, source / "pkg" / "utils" / name)
    for name in ["telecode_message_id.go", "telecode_message_id_test.go"]:
        shutil.copyfile(resources / name, source / "ui" / "rest" / "middleware" / name)
    utils = source / "pkg" / "utils" / "whatsapp.go"
    old_download = '\tdata, err := client.Download(ctx, mediaFile)\n\tif err != nil {\n\t\treturn extractedMedia, err\n\t}\n\n\t// Validate file size before writing to disk\n\tmaxFileSize := config.WhatsappSettingMaxDownloadSize\n\tif int64(len(data)) > maxFileSize {\n\t\treturn extractedMedia, fmt.Errorf("file size exceeds the maximum limit of %d bytes", maxFileSize)\n\t}'
    new_download = '\tmaxFileSize := config.WhatsappSettingMaxDownloadSize\n\tif sized, ok := mediaFile.(interface { GetFileLength() uint64 }); ok && sized.GetFileLength() > uint64(maxFileSize) {\n\t\treturn extractedMedia, fmt.Errorf("media exceeds document limit")\n\t}'
    replace(utils, old_download, new_download)
    replace(utils, 'err = os.WriteFile(extractedMedia.MediaPath, data, 0600)', 'err = downloadTelecodeMedia(ctx, client, mediaFile, extractedMedia.MediaPath, maxFileSize)')
    utils_text = utils.read_text(encoding="utf-8")
    if 'os.' not in utils_text:
        utils.write_text(utils_text.replace('\n\t"os"', ''), encoding="utf-8", newline="\n")
    env = dict(os.environ, CGO_ENABLED="0", GOMAXPROCS="2", GOMEMLIMIT="900MiB", GOGC="50",
               GOCACHE=str(build / "gocache"), GOMODCACHE=str(build / "gomodcache"), GOTOOLCHAIN="local")
    def run(*arguments):
        result = subprocess.run([str(go), *arguments], cwd=source, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", creationflags=0x08000000)
        print(result.stdout, end="", flush=True)
        result.check_returncode()
    print("Checking patched native document path", flush=True)
    run("test", "-p", "1", "-trimpath", "-tags", "purego", "./usecase", "./pkg/utils", "./ui/rest/middleware", "-run", "TestTelecode|TestSendRequestExtras", "-count=1")
    target = args.output.resolve() if args.output else state / "gowa" / "whatsapp-telecode.exe"
    if not target.is_relative_to(state / "gowa") or target.suffix != ".exe":
        raise RuntimeError("The executable output must be inside the private gowa directory")
    print("Building bounded-memory document bridge", flush=True)
    run("build", "-p", "1", "-tags", "purego", "-trimpath", "-o", str(target), ".")
    receipt = {"gowa_commit": COMMIT, "go_version": GO_VERSION, "binary_sha256": hashlib.file_digest(target.open("rb"), "sha256").hexdigest()}
    (build / "build-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"built": str(target), **receipt}), flush=True)


if __name__ == "__main__":
    main()

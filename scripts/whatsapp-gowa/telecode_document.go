package usecase

// TeleCode's local-file document path uses whatsmeow UploadReader, pinned at
// 307a2edf117d. It does not decode, resize, transcode or buffer the original.
import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "strings"

    domainSend "github.com/aldinokemal/go-whatsapp-web-multidevice/domains/send"
    "go.mau.fi/whatsmeow"
    "go.mau.fi/whatsmeow/proto/waE2E"
    "go.mau.fi/whatsmeow/types"
    "google.golang.org/protobuf/proto"
)

const telecodeDocumentMax int64 = 2000000000

func openTelecodeDocument(request domainSend.FileRequest) (*os.File, string, string, error) {
    root, err := filepath.EvalSymlinks(os.Getenv("TELECODE_DOCUMENT_ROOT"))
    if err != nil || root == "" { return nil, "", "", fmt.Errorf("private document root is unavailable") }
    root, err = filepath.Abs(root)
    if err != nil || request.LocalFile == nil { return nil, "", "", fmt.Errorf("missing local document") }
    target, err := filepath.EvalSymlinks(*request.LocalFile)
    if err != nil { return nil, "", "", err }
    target, err = filepath.Abs(target)
    if err != nil { return nil, "", "", err }
    relative, err := filepath.Rel(root, target)
    if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
        return nil, "", "", fmt.Errorf("document is outside the private outgoing directory")
    }
    file, err := os.Open(target)
    if err != nil { return nil, "", "", err }
    fail := func(err error) (*os.File, string, string, error) { _ = file.Close(); return nil, "", "", err }
    info, err := file.Stat()
    if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > telecodeDocumentMax {
        return fail(fmt.Errorf("document size must be between 1 byte and 2 GB"))
    }
    hasher := sha256.New()
    if _, err = io.CopyBuffer(hasher, file, make([]byte, 256*1024)); err != nil { return fail(err) }
    expected, err := hex.DecodeString(request.LocalSHA256)
    if err != nil || len(expected) != sha256.Size || !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), request.LocalSHA256) {
        return fail(fmt.Errorf("document no longer matches the reviewed SHA-256"))
    }
    if _, err = file.Seek(0, io.SeekStart); err != nil { return fail(err) }
    preview := make([]byte, 512)
    n, _ := file.Read(preview)
    if _, err = file.Seek(0, io.SeekStart); err != nil { return fail(err) }
    return file, filepath.Base(target), http.DetectContentType(preview[:n]), nil
}

func (service serviceSend) sendTelecodeDocument(ctx context.Context, client *whatsmeow.Client, recipient types.JID, request domainSend.FileRequest) (response domainSend.GenericResponse, err error) {
    file, name, mime, err := openTelecodeDocument(request)
    if err != nil { return response, err }
    defer file.Close()
    encrypted, err := os.CreateTemp(os.Getenv("TELECODE_DOCUMENT_ROOT"), ".encrypted-*")
    if err != nil { return response, err }
    defer func() { _ = encrypted.Close(); _ = os.Remove(encrypted.Name()) }()
    uploaded, err := client.UploadReader(ctx, file, encrypted, whatsmeow.MediaDocument)
    if err != nil { return response, err }
    // A changed spool file may have been uploaded encrypted, but must never be
    // referenced in a message sent to a recipient.
    if !strings.EqualFold(hex.EncodeToString(uploaded.FileSHA256), request.LocalSHA256) {
        return response, fmt.Errorf("document changed while uploading; no message was sent")
    }
    message := &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
        URL: proto.String(uploaded.URL), DirectPath: proto.String(uploaded.DirectPath),
        FileSHA256: uploaded.FileSHA256, FileEncSHA256: uploaded.FileEncSHA256,
        MediaKey: uploaded.MediaKey, FileLength: proto.Uint64(uploaded.FileLength),
        FileName: proto.String(name), Title: proto.String(name), Mimetype: proto.String(mime),
        Caption: proto.String(request.Caption),
    }}
    message.DocumentMessage.ContextInfo = service.mergeReplyContext(ctx, nil, request.ReplyMessageID)
    sent, err := service.wrapSendMessage(ctx, client, recipient, message, request.Caption)
    if err != nil { return response, err }
    response.MessageID = sent.ID
    response.Status = "Original document accepted by WhatsApp"
    return response, nil
}

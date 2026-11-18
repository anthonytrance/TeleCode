package usecase

import (
    "crypto/sha256"
    "encoding/hex"
    "os"
    "path/filepath"
    "testing"
    domainSend "github.com/aldinokemal/go-whatsapp-web-multidevice/domains/send"
)

func TestTelecodeDocumentScopeAndDigest(t *testing.T) {
    root := t.TempDir()
    t.Setenv("TELECODE_DOCUMENT_ROOT", root)
    target := filepath.Join(root, "original.mp4")
    bytes := []byte("original bytes, no conversion")
    if err := os.WriteFile(target, bytes, 0600); err != nil { t.Fatal(err) }
    hash := sha256.Sum256(bytes)
    req := domainSend.FileRequest{LocalFile: &target, LocalSHA256: hex.EncodeToString(hash[:])}
    file, name, _, err := openTelecodeDocument(req)
    if err != nil { t.Fatal(err) }
    file.Close()
    if name != "original.mp4" { t.Fatal(name) }
    req.LocalSHA256 = hex.EncodeToString(make([]byte, 32))
    if file, _, _, err = openTelecodeDocument(req); err == nil { file.Close(); t.Fatal("changed content was accepted") }
    outside := filepath.Join(t.TempDir(), "private.txt")
    if err := os.WriteFile(outside, bytes, 0600); err != nil { t.Fatal(err) }
    req.LocalFile = &outside
    if file, _, _, err = openTelecodeDocument(req); err == nil { file.Close(); t.Fatal("outside file was accepted") }
}

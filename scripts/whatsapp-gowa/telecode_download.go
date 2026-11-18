package utils

import (
    "context"
    "fmt"
    "io"
    "os"
    "go.mau.fi/whatsmeow"
)

// DownloadToFile's encrypted intermediate needs AES padding and a 10-byte MAC.
// The wrapper caps disk writes as well as the advertised plaintext length.
type telecodeBoundedMediaFile struct { *os.File; limit int64 }
func (f *telecodeBoundedMediaFile) Write(p []byte) (int, error) {
    offset, err := f.File.Seek(0, io.SeekCurrent)
    if err != nil { return 0, err }
    if offset + int64(len(p)) > f.limit { return 0, fmt.Errorf("media exceeds document limit") }
    return f.File.Write(p)
}
func (f *telecodeBoundedMediaFile) WriteAt(p []byte, offset int64) (int, error) {
    if offset < 0 || offset + int64(len(p)) > f.limit { return 0, fmt.Errorf("media exceeds document limit") }
    return f.File.WriteAt(p, offset)
}
func (f *telecodeBoundedMediaFile) Truncate(size int64) error {
    if size < 0 || size > f.limit { return fmt.Errorf("media exceeds document limit") }
    return f.File.Truncate(size)
}

func downloadTelecodeMedia(ctx context.Context, client *whatsmeow.Client, media whatsmeow.DownloadableMessage, target string, limit int64) (err error) {
    file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
    if err != nil { return err }
    defer func() { _ = file.Close(); if err != nil { _ = os.Remove(target) } }()
    err = client.DownloadToFile(ctx, media, &telecodeBoundedMediaFile{File: file, limit: limit+64})
    if err != nil { return err }
    info, err := file.Stat()
    if err != nil { return err }
    if info.Size() > limit { return fmt.Errorf("downloaded document exceeds limit") }
    return nil
}

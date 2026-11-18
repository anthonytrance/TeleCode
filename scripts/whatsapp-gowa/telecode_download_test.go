package utils

import (
    "os"
    "path/filepath"
    "testing"
)

func TestTelecodeBoundedDownloadFile(t *testing.T) {
    file, err := os.OpenFile(filepath.Join(t.TempDir(), "original"), os.O_CREATE|os.O_RDWR, 0600)
    if err != nil { t.Fatal(err) }
    defer file.Close()
    bounded := &telecodeBoundedMediaFile{File: file, limit: 16}
    if _, err = bounded.Write([]byte("exact original")); err != nil { t.Fatal(err) }
    if _, err = bounded.Write([]byte("too much")); err == nil { t.Fatal("unbounded sequential write") }
    if _, err = bounded.WriteAt([]byte("xx"), 15); err == nil { t.Fatal("unbounded random write") }
    if err = bounded.Truncate(17); err == nil { t.Fatal("unbounded truncate") }
}

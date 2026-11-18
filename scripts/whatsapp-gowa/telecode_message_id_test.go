package middleware

import (
	"context"
	"testing"

	"github.com/aldinokemal/go-whatsapp-web-multidevice/infrastructure/whatsapp"
)

func TestTelecodePreallocatedMessageID(t *testing.T) {
	id := "3EB0ABCDEF1234567890123456789012"
	ctx, err := telecodeMessageContext(context.Background(), id)
	if err != nil || whatsapp.SendMessageIDFromContext(ctx) != id { t.Fatal("outgoing ID was not preserved", err) }
	for _, bad := range []string{"short", "../escape", "3EB0ABCDEF1234567890123456789012\n", "3eb0abcdef1234567890123456789012"} {
		if _, err := telecodeMessageContext(context.Background(), bad); err == nil { t.Fatal("invalid ID accepted", bad) }
	}
	if _, err := telecodeMessageContext(context.Background(), ""); err != nil { t.Fatal(err) }
}

package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func session(t *testing.T) (helloRequest, helloResponse, cipher.AEAD, cipher.AEAD) {
	t.Helper()
	public, signing, _ := ed25519.GenerateKey(rand.Reader)
	client, _ := ecdh.X25519().GenerateKey(rand.Reader)
	nonce := make([]byte, 32)
	rand.Read(nonce)
	hello := helloRequest{Protocol: 1, Nonce: base64.StdEncoding.EncodeToString(nonce), Key: base64.StdEncoding.EncodeToString(client.PublicKey().Bytes())}
	response, serverAEAD, err := acceptHello(hello, "S-1-5-21-42", signing)
	if err != nil {
		t.Fatal(err)
	}
	signature, _ := base64.StdEncoding.DecodeString(response.Signature)
	if !ed25519.Verify(public, handshakeTranscript(hello, response), signature) {
		t.Fatal("service identity not authenticated")
	}
	changed := response
	changed.OwnerSID = "S-1-5-21-99"
	if ed25519.Verify(public, handshakeTranscript(hello, changed), signature) {
		t.Fatal("identity substitution accepted")
	}
	raw, _ := base64.StdEncoding.DecodeString(response.Key)
	peer, _ := ecdh.X25519().NewPublicKey(raw)
	shared, err := client.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	key := sha256.Sum256(append(shared, nonce...))
	block, _ := aes.NewCipher(key[:])
	clientAEAD, _ := cipher.NewGCM(block)
	return hello, response, serverAEAD, clientAEAD
}
func clientFrame(aead cipher.AEAD, request serviceRequest) sealedFrame {
	raw, _ := json.Marshal(request)
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	return sealedFrame{Nonce: base64.StdEncoding.EncodeToString(nonce), Data: base64.StdEncoding.EncodeToString(aead.Seal(nil, nonce, raw, []byte("mincave-request/v1")))}
}
func TestAuthenticatedOperationsAndResponses(t *testing.T) {
	_, _, server, client := session(t)
	for _, operation := range []string{"capabilities", "wireguard", "mihomo.start", "mihomo.stop", "mihomo.status", "mihomo.api", "mihomo.reload"} {
		request, err := openRequest(server, clientFrame(client, serviceRequest{Operation: operation}))
		if err != nil || request.Operation != operation {
			t.Fatalf("%s: %v", operation, err)
		}
	}
	for _, operation := range []string{"exec", "powershell", "uninstall", "install", ""} {
		if _, err := openRequest(server, clientFrame(client, serviceRequest{Operation: operation})); err == nil {
			t.Fatalf("unsafe operation accepted: %q", operation)
		}
	}
	frame, err := seal(server, serviceResponse{OK: true, Value: json.RawMessage(`{"running":true}`)})
	if err != nil {
		t.Fatal(err)
	}
	nonce, _ := base64.StdEncoding.DecodeString(frame.Nonce)
	data, _ := base64.StdEncoding.DecodeString(frame.Data)
	if _, err = client.Open(nil, nonce, data, []byte("mincave-response/v1")); err != nil {
		t.Fatal(err)
	}
	if _, err = client.Open(nil, nonce, data, []byte("mincave-request/v1")); err == nil {
		t.Fatal("response reflected as request")
	}
}
func TestTamperingAndReplayBetweenSessions(t *testing.T) {
	_, _, server, client := session(t)
	frame := clientFrame(client, serviceRequest{Operation: "wireguard"})
	data, _ := base64.StdEncoding.DecodeString(frame.Data)
	data[0] ^= 1
	tampered := frame
	tampered.Data = base64.StdEncoding.EncodeToString(data)
	if _, err := openRequest(server, tampered); err == nil {
		t.Fatal("modified ciphertext accepted")
	}
	_, _, other, _ := session(t)
	if _, err := openRequest(other, frame); err == nil {
		t.Fatal("old session ciphertext accepted")
	}
	frame.Nonce = "AA=="
	if _, err := openRequest(server, frame); err == nil {
		t.Fatal("short nonce accepted")
	}
}
func TestHandshakeRejectsMalformedAndLowOrderKeys(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	validNonce := base64.StdEncoding.EncodeToString(make([]byte, 32))
	for _, hello := range []helloRequest{{Protocol: 2}, {Protocol: 1, Nonce: "AA=="}, {Protocol: 1, Nonce: validNonce, Key: "AA=="}, {Protocol: 1, Nonce: validNonce, Key: validNonce}} {
		if _, _, err := acceptHello(hello, "S-1-5-21-42", key); err == nil {
			t.Fatal("invalid handshake accepted")
		}
	}
}

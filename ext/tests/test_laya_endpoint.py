"""Rewire target: the client talks only to our LAN Laya, never to a public Jev host."""

from __future__ import annotations

import json
import shutil
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from jev import client as c

KEY = "laya-key-0123456789abcdef"
Q = {"q": {"type": "noul", "instructions": "x"}}
BODY = c.build_request_body("laya", "state", Q)


# --- endpoint: key must not be able to leave the LAN -------------------------


@pytest.mark.parametrize(
    "host",
    ["10.0.0.5", "192.168.1.20", "172.16.0.1", "172.31.255.254", "127.0.0.1", "::1", "fd12:3456::1",
     "laya.lan", "laya.local", "laya.internal", "laya.home.arpa", "m8.laya.lan"],
)
def test_lan_hosts_accepted(host):
    ep = c.LayaEndpoint(host)
    assert ep.url.startswith("https://") and ep.url.endswith("/v1/systemone")


@pytest.mark.parametrize(
    "host",
    ["8.8.8.8", "1.1.1.1", "2606:4700::1", "api.typesafe.ai", "openrouter.ai", "laya.example.com", "localhost.evil.com",
     "0.0.0.0", "224.0.0.1", "", " ", "laya.lan/..", "user@laya.lan", "laya.lan:443", "laya.lan?x=1", "laya.lan#f",
     "la ya.lan", "laya.lan\n", "http://laya.lan", "172.32.0.1", "11.0.0.1", "192.169.0.1", ".lan"],
)
def test_non_lan_hosts_refused(host):
    with pytest.raises(c.AskRequestError):
        c.LayaEndpoint(host)


@pytest.mark.parametrize("port", [0, -1, 65536, "443", True, None])
def test_bad_ports_refused(port):
    with pytest.raises(c.AskRequestError):
        c.LayaEndpoint("10.0.0.5", port=port)


def test_url_is_fixed_shape():
    assert c.LayaEndpoint("10.0.0.5", port=8443).url == "https://10.0.0.5:8443/v1/systemone"
    assert c.LayaEndpoint("::1", port=8443).url == "https://[::1]:8443/v1/systemone"


def test_external_routes_are_gone():
    for name in ("ROUTES", "ROUTE_TYPESAFE", "ROUTE_OPENROUTER", "PINNED_MODEL_BY_ROUTE", "OPENROUTER_ONLY_MODEL_IDS"):
        assert not hasattr(c, name), name
    src = open(c.__file__).read().lower()
    assert "typesafe" not in src and "openrouter" not in src


def test_send_ask_requires_endpoint_not_route():
    with pytest.raises(TypeError):
        c.send_ask(route="x", key=KEY, body=BODY, user_agent="t")  # type: ignore[call-arg]


def test_ca_file_missing_fails_closed(tmp_path):
    with pytest.raises(c.AskRequestError):
        c.LayaEndpoint("10.0.0.5", ca_file=str(tmp_path / "nope.pem"))


def test_cost_is_local_and_free():
    assert c.cost_for({"input_tokens": 5}) == {"cost_usd": 0.0, "cost_source": "local"}


# --- success reply must not carry the key (review finding) -------------------


def test_success_reply_is_scrubbed_of_key():
    echoed = {"model": "laya-" + KEY, "extra": {"note": [KEY, "ok"]}, "answers": {}}
    script = lambda req, timeout: c.TransportReply(200, {}, json.dumps(echoed).encode())  # noqa: E731
    out = c.send_ask(endpoint=c.LayaEndpoint("10.0.0.5"), key=KEY, body=BODY, user_agent="t", transport=script)
    assert out["status"] == c.STATUS_ANSWERED
    assert KEY not in json.dumps(out)
    assert not c.carries_key_fragment(json.dumps(out["reply"]), KEY)


# --- real TLS round trip on loopback with a private CA -----------------------


@pytest.fixture()
def tls_server(tmp_path):
    if not shutil.which("openssl"):
        pytest.skip("openssl missing")
    cert, keyf = tmp_path / "c.pem", tmp_path / "k.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(keyf), "-out", str(cert),
         "-days", "1", "-subj", "/CN=laya", "-addext", "subjectAltName=IP:127.0.0.1"],
        check=True, capture_output=True,
    )
    seen = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["auth"] = self.headers.get("Authorization")
            seen["path"] = self.path
            n = int(self.headers.get("Content-Length", 0))
            seen["body"] = json.loads(self.rfile.read(n))
            out = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert), str(keyf))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], str(cert), seen
    srv.shutdown()


def test_tls_roundtrip_with_private_ca(tls_server):
    port, cert, seen = tls_server
    ep = c.LayaEndpoint("127.0.0.1", port=port, ca_file=cert)
    out = c.send_ask(endpoint=ep, key=KEY, body=BODY, user_agent="t")
    assert out["status"] == c.STATUS_ANSWERED, out
    assert seen["auth"] == f"Bearer {KEY}" and seen["path"] == "/v1/systemone"
    assert set(seen["body"]) == {"model", "state", "questions"}


def test_tls_untrusted_cert_is_network_error_not_answer(tls_server):
    port, _cert, seen = tls_server
    out = c.send_ask(endpoint=c.LayaEndpoint("127.0.0.1", port=port), key=KEY, body=BODY, user_agent="t")
    assert out["status"] == c.STATUS_NETWORK_ERROR
    assert "auth" not in seen  # key never reached the server

#!/usr/bin/env python3
"""A /v1/models endpoint for deploy/install/test.sh, so the installer's attach path can be
exercised without a real inference server.  usage: fake-openai-server.py <port> <model-id>"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1])
MODEL = sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/v1/models":
            self.send_error(404)
            return
        body = json.dumps(
            {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "test"}]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

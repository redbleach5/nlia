#!/usr/bin/env python3
"""
Mock Ollama server for E2E tests.
Implements minimal /api/chat, /api/embeddings, /api/show, /api/tags endpoints.
Run: python3 tests/e2e/mock-ollama.py
"""
import json
import http.server
import socketserver
import sys
import threading
import time

PORT = 11434

# Pre-canned responses
CHAT_RESPONSES = {
    "default": "Привет! Я Лия. Чем могу помочь?",
    "greeting": "Привет! Рад тебя видеть. Как дела?",
    "factorial": "Факториал 20 = 2432902008176640000",
    "rag": "RAG (Retrieval-Augmented Generation) — это техника, объединяющая поиск по базе знаний с генерацией текста. Основные статьи: Lewis et al. 2020, Karpukhin et al. 2020.",
}

EMBEDDING_768 = [0.1] * 768  # dummy 768-dim embedding

class MockOllamaHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress logs unless debug
        if '--debug' in sys.argv:
            super().log_message(format, *args)

    def do_GET(self):
        if self.path == '/api/tags':
            self._json({
                "models": [
                    {"name": "qwen2.5:7b", "size": 4700000000},
                    {"name": "nomic-embed-text", "size": 274000000},
                ]
            })
        elif self.path.startswith('/api/show'):
            self._json({
                "model_info": {
                    "general.parameter_count": 7000000000,
                    "llama.context_length": 32768,
                },
                "details": {"parameter_size": "7B"},
            })
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len).decode('utf-8') if content_len > 0 else '{}'
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {}

        if self.path == '/api/chat':
            self._handle_chat(data)
        elif self.path == '/api/embeddings' or self.path == '/api/embed':
            self._json({"embedding": EMBEDDING_768})
        elif self.path == '/api/generate':
            self._handle_generate(data)
        else:
            self._json({"error": "not found"}, 404)

    def _handle_chat(self, data):
        messages = data.get('messages', [])
        last_user_msg = next((m.get('content', '') for m in reversed(messages) if m.get('role') == 'user'), '')

        # Pick response based on content
        if any(w in last_user_msg.lower() for w in ['привет', 'hello', 'hi']):
            response = CHAT_RESPONSES['greeting']
        elif 'факториал' in last_user_msg.lower():
            response = CHAT_RESPONSES['factorial']
        elif 'rag' in last_user_msg.lower():
            response = CHAT_RESPONSES['rag']
        else:
            response = CHAT_RESPONSES['default']

        # Stream response token by token (NDJSON)
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()

        tokens = response.split(' ')
        for i, token in enumerate(tokens):
            chunk = {
                "message": {"role": "assistant", "content": token + (' ' if i < len(tokens) - 1 else '')},
                "done": False,
            }
            self.wfile.write((json.dumps(chunk) + '\n').encode())
            self.wfile.flush()
            time.sleep(0.02)  # 20ms per token — visible streaming

        # Final done chunk
        done_chunk = {
            "done": True,
            "total_duration": 1000000000,
            "prompt_eval_count": 50,
            "eval_count": len(tokens),
        }
        self.wfile.write((json.dumps(done_chunk) + '\n').encode())
        self.wfile.flush()

    def _handle_generate(self, data):
        prompt = data.get('prompt', '')
        response = CHAT_RESPONSES['default']
        if 'факториал' in prompt.lower():
            response = CHAT_RESPONSES['factorial']

        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()

        tokens = response.split(' ')
        for i, token in enumerate(tokens):
            chunk = {"response": token + (' ' if i < len(tokens) - 1 else ''), "done": False}
            self.wfile.write((json.dumps(chunk) + '\n').encode())
            self.wfile.flush()
            time.sleep(0.02)

        self.wfile.write((json.dumps({"done": True}) + '\n').encode())
        self.wfile.flush()

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())


def run_mock_ollama():
    server = socketserver.TCPServer(("127.0.0.1", PORT), MockOllamaHandler)
    server.allow_reuse_address = True
    print(f"Mock Ollama running on http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == '__main__':
    try:
        run_mock_ollama()
    except KeyboardInterrupt:
        print("\nMock Ollama stopped")

"""Run against `npm run dev:test`; requires the websockets Python package."""

import concurrent.futures
import http.client
import json
import time
import unittest
import urllib.error
import urllib.request

from websockets.sync.client import connect


BASE = "http://127.0.0.1:8790"


def request(path, method="GET", token=None, body=None, content_type="application/json", timeout=5):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(BASE + path, body, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as response:
        with response:
            return response.code, json.load(response)


class RelayIntegration(unittest.TestCase):
    def test_timeout(self):
        with connect("ws://127.0.0.1:8790/agent", additional_headers={
            "Authorization": "Bearer test-agent"
        }) as agent, concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(request, "/relay", "POST", "test-caller", b'{"payload":"no-reply"}',
                                 timeout=35)
            agent.recv(timeout=5)
            self.assertEqual(future.result(timeout=35), (504, {"error": "agent_timeout"}))

    def test_streaming_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", 8790, timeout=5)
        try:
            connection.putrequest("POST", "/relay")
            connection.putheader("Authorization", "Bearer test-caller")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Transfer-Encoding", "chunked")
            connection.endheaders()
            chunk = b'"' + b'a' * 65536
            connection.send(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
        finally:
            connection.close()

    def test_echo_and_rejection_paths(self):
        self.assertEqual(request("/health")[0], 200)
        self.assertEqual(request("/status")[0], 401)
        self.assertEqual(request("/agent", token="wrong")[0], 401)
        self.assertEqual(request("/relay", "GET", "test-caller")[0], 405)
        self.assertEqual(request("/status", token="test-caller"), (200, {"online": False}))
        self.assertEqual(request("/relay", "POST", "test-caller", b'{}')[0], 503)

        with connect("ws://127.0.0.1:8790/agent", additional_headers={
            "Authorization": "Bearer test-agent"
        }) as agent:
            self.assertEqual(request("/status", token="test-caller"), (200, {"online": True}))
            self.assertEqual(request("/relay", "POST", "test-caller", b'{')[0], 400)
            self.assertEqual(request("/relay", "POST", "test-caller", b'{}')[0], 400)
            self.assertEqual(request("/relay", "POST", "test-caller", b'"' + b'a' * 65536 + b'"')[0], 413)
            self.assertEqual(request("/relay", "POST", "test-caller", b'{}', "text/plain")[0], 415)

            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(request, "/relay", "POST", "test-caller", b'{"payload":{"echo":"hi"}}')
                incoming = json.loads(agent.recv(timeout=5))
                self.assertEqual(incoming["payload"], {"echo": "hi"})
                agent.send(json.dumps({"requestId": incoming["requestId"], "payload": incoming["payload"]}))
                status, response = future.result(timeout=5)
                self.assertEqual(status, 200)
                self.assertEqual(response, incoming)

                first = pool.submit(request, "/relay", "POST", "test-caller", b'{"payload":"first"}')
                second = pool.submit(request, "/relay", "POST", "test-caller", b'{"payload":"second"}')
                messages = [json.loads(agent.recv(timeout=5)) for _ in range(2)]
                agent.send(json.dumps({"requestId": "unknown", "payload": "ignored"}))
                time.sleep(0.1)
                self.assertFalse(first.done())
                self.assertFalse(second.done())
                for message in reversed(messages):
                    agent.send(json.dumps(message))
                self.assertEqual(first.result(timeout=5)[1]["payload"], "first")
                self.assertEqual(second.result(timeout=5)[1]["payload"], "second")

                pending = pool.submit(request, "/relay", "POST", "test-caller", b'{"payload":"pending"}')
                agent.recv(timeout=5)
                with connect("ws://127.0.0.1:8790/agent", additional_headers={
                    "Authorization": "Bearer test-agent"
                }) as replacement:
                    self.assertEqual(pending.result(timeout=5), (503, {"error": "agent_disconnected"}))
                    self.assertEqual(request("/status", token="test-caller"), (200, {"online": True}))

        self.assertEqual(request("/status", token="test-caller"), (200, {"online": False}))


if __name__ == "__main__":
    unittest.main()

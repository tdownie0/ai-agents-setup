#!/usr/bin/env python3
import sys
import urllib.request
import json
import threading
import queue

# Force unbuffered I/O for instant line-by-line agent communication
sys.stdout.reconfigure(line_buffering=True)
sys.stdin.reconfigure(line_buffering=True)

SSE_URL = "http://127.0.0.1:8811/sse"
client_url = None
url_ready_event = threading.Event()
msg_queue = queue.Queue()

def listen_to_sse():
    global client_url
    try:
        req = urllib.request.Request(SSE_URL)
        with urllib.request.urlopen(req) as response:
            buffer = ""
            for chunk in response:
                buffer += chunk.decode('utf-8')
                while "\n\n" in buffer:
                    event_block, buffer = buffer.split("\n\n", 1)
                    lines = event_block.split("\n")
                    
                    for line in lines:
                        # 1. Capture the unique session URL assigned by the gateway
                        if line.startswith("event: endpoint"):
                            for next_line in lines:
                                if next_line.startswith("data:"):
                                    endpoint_path = next_line[5:].strip()
                                    if endpoint_path.startswith("http"):
                                        client_url = endpoint_path
                                    else:
                                        client_url = f"http://127.0.0.1:8811{endpoint_path}"
                                    # Signal that our session_id/client_url is locked and ready
                                    url_ready_event.set()
                        
                        # 2. Forward ONLY valid JSON strings back to Antigravity
                        elif line.startswith("data:"):
                            data_content = line[5:].strip()
                            if data_content and data_content.startswith("{"):
                                sys.stdout.write(data_content + "\n")
                                
    except Exception as e:
        sys.stderr.write(f"SSE Stream Error: {str(e)}\n")

def send_worker():
    """Background worker that waits for the session URL, then posts tool calls."""
    while True:
        line = msg_queue.get()
        if line is None:
            break
            
        # Wait until the SSE handshake completes and yields our active session ID path
        url_ready_event.wait()
        
        try:
            payload = json.loads(line.strip())
            
            # CRITICAL FIX: Ensure the request goes to the absolute session URI assigned to us
            req = urllib.request.Request(
                client_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req) as response:
                response.read() # Read acknowledgement; results stream back via the SSE loop
        except Exception as e:
            sys.stderr.write(f"Write Error: {str(e)}\n")
        finally:
            msg_queue.task_done()

def main():
    # Start the SSE listener thread
    sse_thread = threading.Thread(target=listen_to_sse, daemon=True)
    sse_thread.start()
    
    # Start the message sender processing thread
    sender_thread = threading.Thread(target=send_worker, daemon=True)
    sender_thread.start()
    
    # Continuously read incoming JSON-RPC lines from Antigravity's stdin
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        msg_queue.put(line)

if __name__ == "__main__":
    main()
"""
Nova Act Bridge — Python subprocess that receives commands from the Node.js
automation runner and executes them via the Nova Act SDK.

Nova Act is Python-only (pip install nova-act).
This bridge is spawned as a child process and communicates via JSON over stdin/stdout.

Protocol:
  - Input (stdin): JSON lines, one command per line
  - Output (stdout): JSON lines, one result per line

Commands:
  { "type": "start", "url": "https://...", "headless": true }
  { "type": "act", "prompt": "click the Create button", "maxSteps": 30 }
  { "type": "act_get", "prompt": "get the page title", "schema": {...} }
  { "type": "screenshot" }
  { "type": "elements" }
  { "type": "stop" }

Ref: https://docs.aws.amazon.com/nova-act/latest/userguide/what-is-nova-act.html
Ref: https://github.com/aws/nova-act
"""

import json
import sys
import os
import traceback

def main():
    nova_act_available = False
    NovaAct = None
    BOOL_SCHEMA = None

    try:
        from nova_act import NovaAct as _NovaAct, BOOL_SCHEMA as _BOOL_SCHEMA
        NovaAct = _NovaAct
        BOOL_SCHEMA = _BOOL_SCHEMA
        nova_act_available = True
    except ImportError:
        pass

    nova = None

    def send(data: dict):
        """Send a JSON response to stdout."""
        print(json.dumps(data), flush=True)

    def handle_start(cmd: dict):
        nonlocal nova
        if not nova_act_available:
            send({"error": "nova-act not installed. Run: pip install nova-act"})
            return

        url = cmd.get("url", "about:blank")
        headless = cmd.get("headless", True)
        user_data_dir = cmd.get("userDataDir")

        kwargs = {
            "starting_page": url,
            "headless": headless,
        }
        if user_data_dir:
            kwargs["user_data_dir"] = user_data_dir
            kwargs["clone_user_data_dir"] = True

        nova = NovaAct(**kwargs)
        nova.start()
        send({"status": "started", "url": url})

    def handle_act(cmd: dict):
        nonlocal nova
        if nova is None:
            send({"error": "Session not started. Send 'start' first."})
            return

        prompt = cmd.get("prompt", "")
        max_steps = cmd.get("maxSteps", 30)
        schema = cmd.get("schema")
        timeout = cmd.get("timeout")

        kwargs = {"max_steps": max_steps}
        if schema:
            kwargs["schema"] = schema
        if timeout:
            kwargs["timeout"] = timeout

        result = nova.act(prompt, **kwargs)

        response = {
            "status": "completed",
            "response": result.response,
        }
        if schema:
            response["matchesSchema"] = result.matches_schema
            response["parsedResponse"] = result.parsed_response

        send(response)

    def handle_act_get(cmd: dict):
        nonlocal nova
        if nova is None:
            send({"error": "Session not started. Send 'start' first."})
            return

        prompt = cmd.get("prompt", "")
        schema = cmd.get("schema")

        if schema is None:
            send({"error": "schema required for act_get"})
            return

        result = nova.act(prompt, schema=schema)
        send({
            "status": "completed",
            "matchesSchema": result.matches_schema,
            "parsedResponse": result.parsed_response,
            "response": result.response,
        })

    def handle_screenshot(cmd: dict):
        nonlocal nova
        if nova is None:
            send({"error": "Session not started."})
            return

        # Use underlying Playwright page for screenshot
        import base64
        screenshot_bytes = nova.page.screenshot(full_page=True)
        send({
            "status": "captured",
            "screenshot": base64.b64encode(screenshot_bytes).decode("utf-8"),
        })

    def handle_elements(cmd: dict):
        nonlocal nova
        if nova is None:
            send({"error": "Session not started."})
            return

        # Extract visible interactive elements via Playwright
        elements = nova.page.evaluate("""() => {
            const els = [];
            const selectors = 'button, a, input, select, textarea, [role="button"]';
            document.querySelectorAll(selectors).forEach(el => {
                const label =
                    el.textContent?.trim() ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('placeholder') ||
                    el.getAttribute('name') || '';
                if (label) els.push(label.substring(0, 100));
            });
            return [...new Set(els)];
        }""")
        send({"status": "ok", "elements": elements})

    def handle_stop(cmd: dict):
        nonlocal nova
        if nova is not None:
            nova.stop()
            nova = None
        send({"status": "stopped"})

    handlers = {
        "start": handle_start,
        "act": handle_act,
        "act_get": handle_act_get,
        "screenshot": handle_screenshot,
        "elements": handle_elements,
        "stop": handle_stop,
    }

    # Signal ready
    send({"status": "ready", "novaActAvailable": nova_act_available})

    # Read commands from stdin, one JSON per line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
            cmd_type = cmd.get("type", "")
            handler = handlers.get(cmd_type)
            if handler:
                handler(cmd)
            else:
                send({"error": f"Unknown command type: {cmd_type}"})
        except json.JSONDecodeError as e:
            send({"error": f"Invalid JSON: {str(e)}"})
        except Exception as e:
            send({"error": str(e), "traceback": traceback.format_exc()})

    # Cleanup
    if nova is not None:
        try:
            nova.stop()
        except:
            pass


if __name__ == "__main__":
    main()

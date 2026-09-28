"""One-time (and after long idle) device-code sign-in for teams-chat-mcp."""
from graphauth import device_login

if __name__ == "__main__":
    device_login()

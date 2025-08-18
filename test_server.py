#!/usr/bin/env python3
"""
Test script to verify the AI server is reachable
"""

import requests
import json

# Test the server connectivity
server_url = "http://128.85.34.74:8000/ask-ai"

print(f"Testing connection to: {server_url}")

try:
    test_payload = {
        "query": "Hello, this is a test message",
        "user_ID": "0001"
    }
    
    response = requests.post(server_url, 
                           json=test_payload, 
                           timeout=10)
    
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text[:200]}...")
    
    if response.ok:
        print("✅ Server is reachable and responding!")
    else:
        print("❌ Server returned an error")
        
except requests.exceptions.ConnectTimeout:
    print("❌ Connection timeout - server may be down")
except requests.exceptions.ConnectionError:
    print("❌ Connection error - server unreachable")
except Exception as e:
    print(f"❌ Error: {e}")

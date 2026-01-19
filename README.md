# AI Code Assist [![Demo Video](https://img.shields.io/badge/▶️_Watch_Demo-YouTube-red?style=for-the-badge&logo=youtube)](https://youtu.be/Tl_Zqd9HC6g)

AI Code Assist is a powerful Visual Studio Code extension that brings the capabilities of a large language model directly into your editor. It provides an interactive chat interface, an autonomous agent for complex tasks, and advanced code intelligence features to streamline your development workflow.

## Features
* AI-Powered Chat: Interact with an AI assistant in a dedicated chat view. Ask coding questions, get explanations, and receive suggestions with the full context of your workspace.

* Autonomous Agent Mode: Give the AI agent a high-level task and watch it work. The agent can:

    1. Read, write, and modify files.

    2. Execute terminal commands (with your permission).

    3. Search for files and code snippets.

    4. Perform semantic searches to find relevant code.

* Smart Diff Viewer: When the agent modifies your code, the changes are displayed as interactive diffs directly in the editor. You can accept or reject each change individually or all at once.

* Workspace-Aware Context: The extension indexes your workspace to provide the AI with relevant context, including file structure, function names, classes, and more. This allows for more accurate and helpful responses.

* Conversation Threads: Your conversations are saved and organized into threads, so you can easily pick up where you left off.

## How to Use
Open the Chat View: Click on the AI Code Assist icon in the activity bar to open the chat view.

* Ask a Question: In "Ask" mode, you can ask coding questions, paste code for analysis, or ask for explanations.

* Use the Agent: Switch to "Agent" mode to give the AI a task to perform. For example:

    "Refactor the getUser function in src/service/api.ts to use async/await."

    "Add a new component called UserProfile and import it into the main App component."

    "Install the axios library and create a new service to fetch data from an API."

* Review Changes: When the agent makes changes to your files, you'll see diffs in the editor with CodeLens actions to accept or reject them.

## Commands
AI Code Assist: Open AI Chat: Opens the chat view.

## Requirements
This extension requires a connection to a running AI server. The server URL is configured in the extension's settings.

## Extension Settings
This extension contributes the following settings:

aiCodeAssist.serverUrl: The URL of the AI server.

## Known Issues
Diff manager can be inaccurate at sometimes.

## Release Notes
0.0.1
Initial release of AI Code Assist.

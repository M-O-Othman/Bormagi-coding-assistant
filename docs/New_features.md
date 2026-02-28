New Features

#Document creation#
*specs* in addition to md files, agents who produce documents like architects and technical writers should be able to create documents of open document formats (presentations and documents).
*Status* implemented

Implementation notes:
- Agents can use the `create_document` virtual tool to produce `.docx` (Word) files from Markdown.
- Agents can use the `create_presentation` virtual tool to produce `.pptx` (PowerPoint) files from slide Markdown (`## Slide Title` per slide, `- bullets` for content).
- Both tools require user approval before writing the output file to the workspace.
- Source: `src/utils/DocumentGenerator.ts`, `src/agents/AgentRunner.ts`

 #Virtual meeting#
*specs* add the ability to create a virtual meeting between the user and the agent he specifies in the start a meeting screen. The user will specify the meeting agenda and meeting resources from the files in the workspace. Each agent will address the discussion points from their respective angle, and action items will be put to the agents and added to the memory and task plans in addition to the /virtual-meeting folder (minutes of meeting for each meeting). The user should be able to take decisions among the options proposed by the agents and he can be referee on any conflict.
*Status* implemented

Implementation notes:
- New command: `Bormagi: Start Virtual Meeting` (Command Palette) or the meeting button in the chat toolbar.
- 4-tab UI: Setup (title, agenda, participants, resources) → Meeting (live streaming responses) → Action Items → Minutes.
- Sequential orchestration: each selected agent responds once per agenda item, seeing prior agents' responses.
- User records decisions per agenda item and can mark items resolved.
- Action items are tracked and assignable to specific agents.
- Minutes are generated on demand and saved to `.bormagi/virtual-meetings/<meeting-id>/minutes.md`.
- Source: `src/meeting/`, `src/ui/MeetingPanel.ts`, `media/meeting-room.html`

 #UI Fixes#
*specs* change the setup agents icon to gear icon.
*Status* implemented

Implementation notes:
- The setup-agents toolbar button in `media/chat.html` now uses the Bootstrap gear/cog SVG icon.

#deploy and publish#
*specs* You need the official vsce tool to package and publish your code. The process requires an Azure DevOps account to generate a security token. You use this token to authenticate and upload your extension to the marketplace.

Prepare your project files. Open package.json. Add your publisher name. Add a repository URL. Add an icon path. Update your README file.

*Published Name* "Mohammed Othman" — check for uniqueness. If not unique, use "Mohammed O. Othman".
Install the packaging tool. Open your terminal. Run the command npm install @vscode/vsce.

Generate an access token. Go to the Azure DevOps website. Create an organization. Open User settings. Select Personal Access Tokens.  Create a new token. Set the organization to All accessible organizations. Set the scopes to Custom defined. Select Marketplace and check Manage. Copy the generated token.

Create a publisher profile. Go to the Visual Studio Code Marketplace management page.  Sign in with your Microsoft account. Create a new publisher. Ensure the publisher name matches the one in your package.json file.

Authenticate your terminal. Open your terminal. Run the command npx vsce login your_publisher_name. Paste your personal access token when prompted.

Package your extension locally. Run the command npx vsce package. This creates a VSIX file in your directory. You can install this file manually in Visual Studio Code to test it.

Publish your extension. Run the command npx vsce publish. This uploads your extension to the store.

Options
Manual Upload: You can log into the Visual Studio Code Marketplace management page and manually upload the generated VSIX file instead of using the publish command.
Automated Publishing: You can configure GitHub Actions to run the publish command automatically when you push new code.

Constraints
The marketplace requires a unique publisher name.
The extension name must be unique within your publisher namespace.
The token expires after a set duration and requires periodic renewal.

<confidence>
High: Verified facts based on official Visual Studio Code extension publishing documentation.
</confidence>
*Status* implemented

Implementation notes:
- `package.json` updated with `repository`, `homepage`, `bugs`, `license`, vsce npm scripts.
- `@vscode/vsce` and `sharp` added as devDependencies.
- `scripts/generate-icon.js` generates `media/icon.png` (128×128) from the SVG using `sharp`.
- `.vscodeignore` controls what is excluded from the packaged `.vsix`.
- `PUBLISHING.md` contains the complete step-by-step publishing guide.
- **Pending**: Set `"publisher"` in `package.json` once publisher name is verified at marketplace.visualstudio.com (see Open_questions Q-006).

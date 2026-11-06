# Privacy

GitHub Task Tracker has no server, telemetry, analytics, advertisements, account, or GitHub token. It never modifies GitHub's public labels, PRs, comments, or projects.

## What is stored

- Your label definitions (ID, name, and color).
- Repository names, PR numbers, and the IDs of labels you assign to them.
- Private plain-text notes, up to 2,000 characters per PR, including for PRs with no remaining labels. Notes are included in JSON backups and never sent to GitHub.

The extension reads PR links in GitHub's native PR lists and the URL of individual PR Conversation pages to match them to your assignments. It adds a separate private section below the public Labels section in the PR sidebar. It stores data in `chrome.storage.local` in your current browser profile. Extension pages and the service worker access storage; content scripts request data through internal extension messaging. No data is synchronized by this extension to other devices.

## Native PR filtering

The private filter only hides nonmatching PR rows already rendered by GitHub. It does not request or cache additional PR titles, authors, avatars, or states. Clicking GitHub's ordinary pagination links loads the next GitHub page normally and retains the private filter.

Private label definitions and assignments are not uploaded. The filter ID is stored in a URL fragment (`#private-label=…`), which is not sent in HTTP requests. No third-party backend or GitHub API is used. Filtering on personal PR lists also includes the clicked PR's repository in that local fragment.

## My tasks details

Opening **My tasks** reads GitHub HTML pages for the locally tracked PRs on the currently displayed task page (or all matching PRs for metadata sorting), using your browser session. Those read-only requests obtain the title, author username, base/target branch, and PR status. They do not send private label names or assignments to GitHub. Up to four requests run concurrently. Details are considered fresh for five minutes; older details stay visible while background updates run. Up to 500 tracked PR details are also kept in that tab's session storage to support reloads and discarded-tab recovery. This session cache is separate from permanent label storage and is not included in JSON backups. Closing the tab normally ends its cache session; browser session/tab restoration may restore it. Cached details are never uploaded by the extension. Failed or inaccessible PRs remain in the index by repository and number, with a loading error and retry option.

Only My tasks loads these additional details. Native PR lists and individual PR label controls do not fetch PR metadata. All locally tracked PRs in the current browser profile are eligible for the task index; current GitHub access determines whether details can be read.

## What “private” means

Labels and notes are not published to GitHub or shared with collaborators. Labels displayed in a page may be visible to someone viewing your screen, screenshots, or other software able to read your browser's rendered page. Local storage and exported JSON backups are not encrypted by this extension. Someone with access to your browser profile can access the data.

This version does not separate data by signed-in GitHub account: all GitHub accounts used in the same browser profile share the same local labels. Use separate Chrome profiles if you need separate data.

## Backup and deletion

Use **Export JSON** to download your own backup. Backups include repository names and PR numbers. **Import JSON** validates the file and previews its contents before you explicitly replace existing data. Removing a label also removes its assignments. Uninstalling the extension removes its local storage. Reloading or updating the same installed extension preserves data; loading a copy from a new folder may give it a different identity and separate storage.

## Permissions

- `storage`: saves your private label definitions, assignments, and notes.
- Host access to `https://github.com/*`: allows My tasks to read PR HTML for its title, author, base branch, and status. No GitHub API or other host is contacted for these details.
- A content script on `https://github.com/*`: reads PR links and the current PR URL, and displays label controls in supported lists and PR Conversation sidebars. The broad page match lets the extension follow GitHub's navigation without requiring a page reload. It only adds controls to these supported PR routes.

No GitHub API, additional hosts, clipboard access, history access, or remote code are used.

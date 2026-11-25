/* IPMS user guide (English) — shown by help.js; same structure as help-zh.js */
window.TT_HELP_EN = [
  {
    id: 'start', icon: 'home', title: 'Getting started',
    intro: 'IPMS puts the department\'s link portal, daily operations to-dos and projects in one system. The sidebar is on the left, the header on top and the task radar in the bottom-right corner.',
    items: [
      { h: 'Signing in', b: `<ul>
        <li>Sign in with your AD account: type just the name; the domain suffix (e.g. <code>@corp.local</code>) is added for you. Local admins and names that already contain <code>@</code> or <code>DOMAIN\\</code> get no suffix.</li>
        <li>When Microsoft Entra ID is set up, you can use “Sign in with Microsoft” (supports MFA).</li>
        <li>A first-time account is a <b>guest</b>: it only sees the public portal links, and a banner asks you to contact a system administrator to be promoted to “User” or above.</li>
      </ul>` },
      { h: 'Header', b: `<ul>
        <li><b>Search…</b> (<kbd>Ctrl</kbd>+<kbd>K</kbd>): finds links and cards, see “Portal → Search”.</li>
        <li><b>Clock</b>: synced with the server; shows the date, ISO week and weekday, next to your IP and public IP.</li>
        <li><b>🔔 Reminders</b>: assignments, @mentions, new comments, due and overdue reminders; the number is how many need attention.</li>
        <li><b>⚡ Low-resource mode</b>: turns off animations and blur, for old PCs or remote desktop.</li>
        <li><b>Theme</b> (monitor / sun / moon): follow system, light, dark.</li>
        <li><b>EN / 中</b>: switches the interface language, saved to your account.</li>
        <li><b>Account menu</b>: profile, admin console (admins), sign out.</li>
      </ul>` },
      { h: 'Sidebar', b: `<ul>
        <li>Home, Favorites, Recent, My work, Task board, Projects, History, Help, followed by the <b>Public</b> area (shared link folders) and the <b>Personal</b> area (only you see it).</li>
        <li>The red number next to Task board and Projects: your overdue + due-today items.</li>
        <li>The top-left button or <kbd>Ctrl</kbd>+<kbd>B</kbd> collapses it to an icon rail; hover over the rail to see the full sidebar.</li>
      </ul>` },
      { h: 'Keyboard shortcuts', b: `<table>
        <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> or <kbd>/</kbd></td><td>Open search</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>B</kbd></td><td>Collapse / expand the sidebar</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close a dialog, leave focus mode, end selection</td></tr>
        <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+click a card</td><td>Enter selection mode and tick the card</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>Send a comment</td></tr>
        <tr><td><kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd></td><td>Reorder subtasks</td></tr>
        <tr><td><kbd>Shift</kbd>+<kbd>Enter</kbd> (in search)</td><td>Open the full results page</td></tr>
      </table>` },
      { h: 'Your settings follow your account', b: 'Favorites, recent links, theme, sidebar state, board / Gantt / radar view choices, export format and language are stored in your profile on the server, so they are the same on any PC or browser.' },
      { h: 'Install as an app, mobile', b: 'The install button in the Chrome / Edge address bar (or the install icon in the header) installs IPMS as a standalone window; on a phone use “Add to Home Screen”. Phones, tablets and desktops are all supported.' },
    ],
  },
  {
    id: 'portal', icon: 'folder', title: 'Portal (links)',
    intro: 'The systems, devices, documents and ticket URLs the department uses, organized in folders.',
    items: [
      { h: 'Home', b: 'Home is made of sections: announcements, quick links, task board, favorites, recent, public area, personal area or a specific folder. Administrators choose and order them under “Home layout”.' },
      { h: 'Browsing folders', b: 'Open a folder from the sidebar or a folder card on Home; the breadcrumb takes you back up. Every folder has its own URL, so bookmarks and Back work. Switch between <b>grid / list</b> at the top right.' },
      { h: 'Search', b: `<ul>
        <li>Click “Search…” in the header, press <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd>.</li>
        <li>Matches link names, descriptions, URLs, paths and icons, and also <b>board cards</b>: title, description, comments, creator and assignees; type <code>#tag</code> to find cards with that tag.</li>
        <li><kbd>↑</kbd><kbd>↓</kbd> to choose, <kbd>Enter</kbd> to open (a card opens its editor), <kbd>Shift</kbd>+<kbd>Enter</kbd> for all results. Only cards you may see are found; history cases come last.</li>
      </ul>` },
      { h: 'Favorites and recent', b: 'Click ☆ on a link card to add or remove a favorite. Links you opened recently appear in “Recent”. Both are yours only.' },
      { h: 'Personal area: your own links', b: `<ul>
        <li>Click ＋ next to “Personal” in the sidebar to add a link or folder that only you see.</li>
        <li><b>Drag to add</b>: drag the address bar, a link on a page or a bookmark onto the page; the title and site icon are filled in. Drop it on a folder to put it there.</li>
      </ul>` },
      { h: 'Public area', b: 'Maintained by administrators and shared by everyone. Some folders may be limited to certain departments or people; folders you cannot see do not appear in the sidebar, Home or search.' },
      { h: 'Quick links and quick filter', b: 'Quick links on Home are grouped shortcut buttons (e.g. network login pages per site). Clicking a link\'s icon lists every link with the same icon (e.g. all devices of one brand).' },
      { h: 'Local programs (Windows portable)', b: 'Drag a program shortcut (.lnk), URL shortcut (.url) or executable (.exe) into the portal; the path, arguments and icon are read automatically, and clicking the card starts it on this PC. Works only on the PC running the portable edition.' },
    ],
  },
  {
    id: 'board', icon: 'kanban', title: 'Task board',
    intro: 'Daily operations work and project cards live here. One column per status; drag a card to change its status.',
    items: [
      { h: 'Columns (statuses)', b: `<table>
        <tr><td>Recurring</td><td>Daily / weekly … work waiting for this period to be closed</td></tr>
        <tr><td>Overdue</td><td>One-off cards past their due date and not closed move here automatically (shown only when there are some)</td></tr>
        <tr><td>New</td><td>Created, not started</td></tr>
        <tr><td>On going</td><td>In progress</td></tr>
        <tr><td>Pending</td><td>Waiting for confirmation or a reply</td></tr>
        <tr><td>On hold</td><td>Paused</td></tr>
        <tr><td>Complete</td><td>Done</td></tr>
        <tr><td>Canceled</td><td>Canceled</td></tr>
      </table>Empty columns collapse into a narrow strip; click to expand. You can also drop a card on the strip.` },
      { h: 'Adding a card', b: 'Click “New card” (above the board or at the bottom of a column, which sets that status). Enter a title and click “Add”; the other fields can be filled in later. A new card is assigned to you by default.' },
      { h: 'Moving and ordering', b: 'Drag a card to another column to change its status, or up and down in a column to reorder. Cards with subtasks get their status calculated automatically (see “Card → Summary cards”), but can still be dragged.' },
      { h: 'Filters and views', b: `<ul>
        <li><b>Whose cards</b>: everyone, mine, me and my reports, one report, one department (depending on your permissions).</li>
        <li><b>All / Ops / Projects</b>: only changes what is shown; project alerts always stay in the project strip.</li>
        <li><b>Hide complete / canceled</b>: a toggle.</li>
        <li><b>Tags</b>: click a tag on a card to show only cards with it; click again or “Clear” to reset.</li>
      </ul>` },
      { h: 'Layouts', b: `<ul>
        <li><b>Board</b>: one column per status.</li>
        <li><b>By person</b>: one row per person with status columns; drag to change status, click the row\'s “Add” to create a card assigned to them.</li>
        <li><b>Gantt</b> and <b>Board + Gantt</b>: see “Gantt and scheduling”.</li>
      </ul>` },
      { h: 'People bar', b: 'Above the board: each person with their workload (status-colored squares; ⛔ counts their blocked cards). Click a person to <b>focus</b>: only the cards they own, plus cards they take part in (dashed border, saying what they do). Click again or press <kbd>Esc</kbd> to leave. Managers see all their reports.' },
      { h: 'Project strip', b: 'One line above the board: how many projects are running, how many are late (by up to how many days), how many have problems, this week\'s milestones; click it to open Projects.' },
      { h: 'Workload thresholds', b: 'When a column holds more cards than the threshold, its header says “Busy” or “Overloaded” (set by administrators; 6 and 9 cards by default).' },
      { h: 'Select and export', b: 'Click “Select / export” or <kbd>Ctrl</kbd>+click a card: tick cards, “Select this column” or “Select all shown”, then “Export report”. There are also “Export by person…” and “Import report…”. See “Export and import”.' },
      { h: 'Live updates', b: 'When someone changes a card, your screen updates right away without reloading.' },
    ],
  },
  {
    id: 'card', icon: 'edit', title: 'Card (editor)',
    intro: 'Click a card to open its editor. The top half holds the card\'s fields, the bottom half comments and subtasks. Only people who may edit see “Save”; when read-only, a banner at the top says why.',
    items: [
      { h: 'Title and description', b: 'The title is required. Use the description for details, steps and links; typing <code>@</code> in it pops up a list of colleagues, and anyone @mentioned can see the card and is notified.' },
      { h: 'Tags', b: `<ul>
        <li>Type a name in “Tags” and press <kbd>Enter</kbd>, or click a recent one under “Frequent”. Up to 8 tags per card, 24 characters each.</li>
        <li>A name always has the same color (administrators can set colors). Click a tag on a card to filter the board; search <code>#tag</code> finds it too.</li>
      </ul>` },
      { h: 'Type: Ops or Project', b: `<ul>
        <li><b>Ops</b>: day-to-day work. You can choose “Belongs to project” so it also appears in that project\'s Gantt and board (e.g. a purchase order during the project).</li>
        <li><b>Project</b>: gets its own project page (Gantt, project board, list) and shows on the board as a project card with completion, vs. baseline, next milestone and problem count.</li>
      </ul>` },
      { h: 'Status and priority', b: 'Status matches the board columns; priority is High, Normal or Low (it decides the radar quadrant). Cards with subtasks have their status calculated, but you can still change it by hand.' },
      { h: 'Start and due', b: `<ul>
        <li>Dates may include a time; no time = all day. Shortcuts: <b>Today</b>, <b>Tomorrow</b>, <b>Next Monday</b>, <b>In a week</b>, <b>Clear</b>.</li>
        <li>Still in New after the start date: a “Time to start” reminder; past the due date: overdue (red).</li>
        <li>With subtasks, start and due are derived from the subtasks and cannot be edited here (change the lower levels).</li>
      </ul>` },
      { h: 'Reminder', b: 'At the due time, 15 minutes, 1 hour, 1 day, 2 days or 1 week before, or none. When it is time it appears in 🔔 and, if allowed, as a desktop notification. Cards without a due date are not reminded.' },
      { h: 'Repeat (recurring work)', b: `<ul>
        <li>Daily, every weekday (Mon–Fri), weekly (choose weekdays), monthly, yearly, with “every N days / weeks / months / years”. Repeating needs a due date.</li>
        <li>At the deadline (18:00 for all-day cards) a dialog asks: <b>Close and schedule next</b> (this card goes to Complete and a copy is made for the next deadline, with subtasks and attachments copied and statuses reset) or <b>Ask again in 1 hour</b>.</li>
        <li>Dragging the card to Complete also schedules the next one. If several periods were missed, the next one is placed after today.</li>
      </ul>` },
      { h: 'Assignees and collaborators', b: `<ul>
        <li><b>Assign</b>: board admins, department admins and managers can assign owners (several = shared responsibility). A user\'s cards belong to themselves by default.</li>
        <li><b>Collaborators</b>: people @mentioned or co-owning without their own subtask. They can tick “Done” in the task tree (themselves, or anyone who can edit the card), which counts towards completion.</li>
      </ul>` },
      { h: 'Schedule (Gantt)', b: `<ul>
        <li><b>Milestone</b>: only the due date counts; drawn as ◆ on the Gantt.</li>
        <li><b>Predecessors</b>: search any card or subtask you can see and set a “gap (days)” (0 = start the day after it ends; may be negative). Starting before a predecessor ends is a <b>schedule conflict</b>. You cannot pick the item itself or create a loop.</li>
        <li><b>Shared window</b>: which outage, maintenance window or change freeze this work uses (set by administrators); exceeding its project capacity or landing in a freeze is a <b>window conflict</b>.</li>
        <li><b>Actual start</b>: recorded automatically the first time it goes to On going or gets time logged; can be corrected.</li>
        <li><b>Baseline</b>: “Set baseline” saves the current dates of the card and every subtask as the plan; the Gantt then draws grey lines and shows days late or early. It can be reset or cleared.</li>
      </ul>` },
      { h: 'Attachments', b: `<ul>
        <li>Click “Add files”, paste (<kbd>Ctrl</kbd>+<kbd>V</kbd>) or drop files on the dialog; they are saved immediately. Drop on the comment box to attach to a comment.</li>
        <li>Images (PNG, JPG, GIF, WebP, up to 10 MB each) show thumbnails; the first is the cover. Click to enlarge, <kbd>←</kbd><kbd>→</kbd> to browse.</li>
        <li>Documents: PDF, Word, Excel, PowerPoint, md, json, yaml, toml, txt, py, rs, mermaid (up to 25 MB each). PDFs and text files open in the browser; Office files download.</li>
        <li>Only people who can see the card can open its attachments; file contents are checked on upload.</li>
      </ul>` },
      { h: '⛔ Mark blocked', b: 'When work is stuck waiting for someone, click “⛔ Mark blocked…” and write what it is stuck on and who you are waiting for. The card gets a red border with “Blocked N days”, a comment is added, and the card\'s people and the owner\'s manager are notified. Owners, collaborators and managers can mark it or click “✅ Unblock”; closing or canceling unblocks it automatically.' },
      { h: 'Summary cards: calculated status', b: `A card with subtasks is a summary task, recalculated when subtasks or collaborators change:<ul>
        <li>All subtasks done and every collaborator ticked → Complete; subtasks done but a collaborator not ticked → Pending.</li>
        <li>Nothing started → New; otherwise On going &gt; Pending &gt; On hold (canceled ones do not count).</li>
        <li>You can still change the status or drag it, which holds until the next subtask change; setting Complete while subtasks are open asks first.</li>
      </ul>` },
      { h: 'Badges on a card', b: `<ul>
        <li>Red “N days overdue”, “Due today”, “Time to start”; ⛔ red border = blocked.</li>
        <li>“Subtasks x/y · collaborators n ⧉”: click to open the task window. Completion = (done subtasks + ticked collaborators) ÷ (non-canceled subtasks + collaborators).</li>
        <li>“Timing”: you are timing one of this card\'s subtasks.</li>
        <li>“Report”: a card of one of your reports; dashed border: in focus mode, this person takes part in someone else\'s card.</li>
      </ul>` },
      { h: 'Buttons at the bottom', b: `<ul>
        <li><b>Excel</b>: exports this card (with subtasks, comments, time) as a progress report.</li>
        <li><b>Task window</b>: subtask levels open left to right, see “Subtasks and task window”.</li>
        <li><b>Delete</b>: only for the creator or admins who may edit all cards.</li>
        <li><b>Save</b>: <kbd>Enter</kbd> does not submit, to avoid accidents; click “Save” or “Add”.</li>
      </ul>` },
      { h: 'Read-only and history cases', b: 'A “Read-only” banner means you can view and comment but not change fields (e.g. read-only admins, or someone assigned a subtask looking at the main card). A “History case” banner means the card was closed longer than the configured time (72 hours by default); nobody can change it or comment.' },
    ],
  },
  {
    id: 'subtasks', icon: 'layout', title: 'Subtasks and task window',
    intro: 'A card can be broken down into any number of subtask levels. Each level has its own assignee, dates, time, comments and attachments, and its status rolls up.',
    items: [
      { h: 'Creating subtasks', b: `<ul>
        <li>Click “<b>Make subtask</b>” on a comment to turn it into a subtask (the comment becomes its description); “Back to comment” undoes it.</li>
        <li>Or click “＋ New L2 subtask” in the task window or the full editor, type a name and press <kbd>Enter</kbd>.</li>
        <li>Each subtask can have its own children, with <b>no limit on depth</b> (the card is L1, then L2, L3…).</li>
      </ul>` },
      { h: 'Subtask fields', b: 'Name, status, assignee, priority, start / due (with time), estimate, reminder, description, attachments and the schedule fields (milestone, predecessors, shared window, actual start). The common fields are edited inline; “Edit subtask / More settings” opens the full dialog.' },
      { h: 'Who can change what', b: `<ul>
        <li>Anyone who can edit the card: add and change any level.</li>
        <li>A subtask\'s assignee: can change their subtask (everything except the assignee) and add, change, assign, log time on and delete the levels below — an upper-level assignee controls the whole branch.</li>
        <li>Someone assigned a subtask can see the main card (read-only + comments), and 🔔 reminds them of their own subtask\'s due and overdue dates.</li>
      </ul>` },
      { h: 'Timer and time log', b: `<ul>
        <li><b>▶ Start timer</b> / <b>■ Stop</b>: stopping asks “What did you do?”, and lets you correct hours and date.</li>
        <li><b>Log time</b>: enter hours, date and a note by hand.</li>
        <li>Open “Time log” for the entries; click ✎ on one to change its note, hours and date (your own entries, or anyone who can edit the card).</li>
        <li>The card summary shows logged / estimated hours. Reassigning or closing stops a running timer.</li>
      </ul>` },
      { h: 'Outline and ordering', b: 'Under the card summary is the subtask outline (numbers 1, 1.1, 1.1.1…, status, assignee, due); click a line to jump to it. People who can edit the card can drag or use <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> to reorder.' },
      { h: 'Task window', b: `<ul>
        <li>Open it from “Subtasks x/y ⧉” on a card, “Task window” at the bottom of the editor, “Task tree (N)” on a subtask, or “Task window” on a project page.</li>
        <li>Columns run left to right: the first is the card (status, time, progress, subtasks and card comments); click a subtask to open it on the right. One item per level is open at a time.</li>
        <li>Each column edits name, status, assignee, priority, dates, estimate and description directly, with the time log, comments and next-level subtasks below.</li>
        <li>The path at the top jumps back to any level; “Full edit” opens the usual card editor; “More settings” opens the full subtask dialog.</li>
      </ul>` },
      { h: 'Deleting a subtask', b: 'The bin icon at the top right of a subtask deletes it together with its children, time entries and comments. This cannot be undone.' },
    ],
  },
  {
    id: 'comments', icon: 'message', title: 'Comments, @mentions and attachments',
    intro: 'Every card and subtask can have comments and replies.',
    items: [
      { h: 'Comments and replies', b: `<ul>
        <li>Type in “Comment on the card…” and click “Send” or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.</li>
        <li>“Reply” to a comment to start a thread; replying to a reply @mentions its author, and everyone in the thread is notified.</li>
        <li>You can edit your own comments (shown as “edited”) or delete them (with their replies).</li>
      </ul>` },
      { h: '@mentioning colleagues', b: 'Typing <code>@</code> pops up a list (managers / reports / peers first); the person you pick can see the card and is notified. When AD is reachable you can also @mention people who have never signed in.' },
      { h: 'Comment attachments', b: 'Click the paper clip in the comment box, paste or drop a file; it is attached to that comment. Read-only admins cannot change card attachments but can attach files to comments.' },
      { h: 'Sorting and filtering', b: 'Top right of the comments: “Oldest first / Newest first” changes the order; “All comments / Subtasks only” lists only subtasks. Your choice is saved to your account.' },
    ],
  },
  {
    id: 'gantt', icon: 'calendar', title: 'Gantt and scheduling',
    intro: 'The layout switch at the top right of the board has “Gantt” and “Board + Gantt” (board above, Gantt below).',
    items: [
      { h: 'Reading the Gantt', b: 'Cards are L1 and subtasks open by level (▸ expand / collapse, or “Expand all / Collapse all”). Bar color = status, the filled part = completion, red border = overdue; ◆ is a milestone; the grey underline is the baseline; arrows are predecessor links (red = schedule conflict); the red vertical line is today.' },
      { h: 'Editing by dragging', b: 'Drag a bar to move its dates, or its ends to change start or due; changes are saved immediately. When later work depends on it, you are asked whether to shift it too. Click a name or bar to open the card (a subtask opens in the task window at its level).' },
      { h: 'Scale and tools', b: 'Day / Week / Month changes the scale; “Today” jumps back; “Hide unscheduled” skips cards without any date; “Export” exports the cards on the Gantt (Excel Gantt or MS Project).' },
      { h: 'Linked with the board', b: 'On by default: only the cards the board currently shows are listed (whose cards, focus, tags and hide-complete all apply), and hovering a row highlights its card. Turn it off for an independent Gantt with its own search, “Only mine” and hide-complete.' },
      { h: 'Scheduling rules', b: 'Items with subtasks start and end exactly where their subtasks do; a project card spans the whole project.' },
    ],
  },
  {
    id: 'projects', icon: 'flag', title: 'Projects',
    intro: 'Set a card\'s type to “Project” to make it a project. “Projects” in the sidebar lists them all; click a project card to open its page.',
    items: [
      { h: 'Projects: list', b: 'Every project ordered by manager: completion, days behind baseline, next milestone, problem counts and a mini Gantt. Board and department admins can reorder with ▲▼ (the radar, alert list and reports use this order). Below it, “ops cards that look like projects” are suggested for conversion.' },
      { h: 'Projects: people load', b: 'A person × week heat map: each cell totals the <b>estimated hours</b> of unfinished items due that week (across all projects and ops cards) and turns red above the limit (40 hours a week by default); items without an estimate count as 4 hours and are flagged. Click a cell to see which projects overlap.' },
      { h: 'Projects: windows and cross-project', b: 'Which work uses each shared window (outage, maintenance window, change freeze), and whether it exceeds the project capacity or falls in a freeze; plus “cross-project predecessors” that live in another project and are late.' },
      { h: 'Project page', b: `<ul>
        <li>At the top: completion, vs. baseline, next milestone and items with problems; plus how many items you have due today or overdue elsewhere.</li>
        <li><b>Gantt</b> (this project and the cards that belong to it), <b>project board</b> (work at every level by status; drag to change status), <b>list</b> (WBS numbers, same as the Excel report).</li>
        <li>Buttons: task window, edit project card, Excel report, and this project\'s <b>notification settings</b>.</li>
      </ul>` },
      { h: 'What counts as a problem', b: 'The radar, alert list, Projects, Excel and notifications all use the same set: <b>overdue</b>, <b>blocked</b>, <b>schedule conflict</b> (starts before a predecessor ends), <b>late cross-project predecessor</b>, <b>window conflict</b>, <b>overloaded person</b>.' },
      { h: 'Project notifications', b: 'At the top right of the project page: All / Only mine / Daily digest / Off (owners default to All, other participants to Only mine). Sent daily at the reminder time: behind baseline, late cross-project predecessors, window conflicts, milestones due within 3 days; each event is sent once.' },
    ],
  },
  {
    id: 'mine', icon: 'bell', title: 'My work, notifications and radar',
    items: [
      { h: 'My work', b: '“My work” in the sidebar: everything assigned to you across projects and ops cards, grouped into overdue, today, within 3 days, this week and later, showing which project and level each comes from. Click one to open it.' },
      { h: '🔔 Reminders', b: 'The 🔔 in the header: assignments, @mentions, new comments, project notifications, and due, overdue and time-to-start reminders. Click one to open its card or project; “Mark all read” clears them.' },
      { h: 'Desktop notifications', b: 'The first time you are asked whether to allow browser notifications; once allowed, due times and reminders show a system notification (administrators can turn this off).' },
      { h: 'Overdue reminder', b: 'Every morning (09:30 by default) a dialog lists all overdue cards so you can close or open them right away.' },
      { h: 'Task radar', b: `<ul>
        <li>Floats in the bottom-right corner and can shrink to a small square (showing the overdue count). Nearer the center = more urgent: overdue → today → 3 days → 7 days → 30 days → later.</li>
        <li>Four quadrants: I high priority, II normal, III low, IV paused (Pending / On hold / Canceled).</li>
        <li>Only items that need attention are drawn: ops cards are diamonds, subtasks small dots; healthy ones are merged into “N healthy” at the bottom left (click to show them).</li>
        <li>Each <b>project is a hexagon</b>: distance = next milestone, color = health, number = problems; click it for the <b>project radar</b>, where sectors are phases and clicking a blip opens it in the task window.</li>
        <li>The “Alerts” tab lists every problem, filterable by type or only mine.</li>
      </ul>` },
    ],
  },
  {
    id: 'history', icon: 'archive', title: 'History',
    items: [
      { h: 'What moves to History', b: 'A main card that has been Complete or Canceled longer than the configured time (72 hours by default; administrators can change it) leaves the board, Projects and radar and moves to “History”. Reopening (changing the status back) is only possible before that.' },
      { h: 'Using it', b: 'Two tabs, “Ops” and “Projects”; search titles, tags and people, filter by complete / canceled and closing year, and “Export Excel” the filtered results. Click an ops card to view it; click a project to open its page (Gantt, project board and list are all there).' },
      { h: 'View only', b: 'Nobody can change, comment on or delete a history case (the server refuses it, including changes synced from the portable edition). Attachments, time and comments are all kept and can be viewed and exported.' },
    ],
  },
  {
    id: 'export', icon: 'download', title: 'Export and import (Excel, MS Project)',
    items: [
      { h: 'Where to export', b: 'Board “Select / export” then “Export report”; “Excel” in the card editor; “Excel report” on a project page; “Export” on the Gantt toolbar; “Export Excel” in History; “Export by person…” on the board.' },
      { h: 'Three formats', b: `<ul>
        <li><b>Progress report (Excel)</b>: a tree (task 1, subtask 1.1…, folded with Excel\'s ＋ / − on the left) with status, dates, % complete, milestone, predecessors, estimated / actual hours, latest progress and time details; plus “Projects”, “People load” and “Problems” sheets. Printing is set up (A4 landscape, repeated headers).</li>
        <li><b>Report + Gantt (Excel)</b>: adds a “Gantt” sheet with status-colored bars, milestones, today and baseline, printed on A3 landscape; scale auto, day, week or month.</li>
        <li><b>MS Project (XML)</b>: opens directly in Microsoft Project or ProjectLibre, keeping levels, predecessors and gaps, milestones, baseline and assignees.</li>
      </ul>` },
      { h: 'Export by person', b: 'Tick people or a whole department, optionally limit by status and ops / projects, and export every card they take part in; by default only their own subtasks are listed (cards they own or co-own are listed in full).' },
      { h: 'Import report', b: `<ul>
        <li>“Import report…” takes an exported Excel file: change status, dates, assignees, estimates, milestones (◆ / yes to set, no to clear) and predecessors in Excel, or insert rows (empty system ID = new, its parent found from numbers like 1.2.3).</li>
        <li>A preview shows each row as new, updated, unchanged or error, with the changes; click “Apply” to confirm.</li>
        <li>Empty cells never clear existing values; rows with errors are not imported. History cases cannot be changed by import.</li>
      </ul>` },
    ],
  },
  {
    id: 'dashboard', icon: 'grid', title: 'War room (public dashboard)',
    items: [
      { h: 'Opening it', b: 'Go to <code>/dashboard</code>; no sign-in needed, made for meeting-room and office screens. It only shows counts and progress, never card contents, and refreshes every 15 seconds.' },
      { h: 'What it shows', b: 'Counts per status with an 8-week trend, due-date spread, project progress (days late, problems, next milestone; names may be anonymized), a status bar per person per department, people load and system status lights.' },
      { h: 'Modes (URL parameters)', b: `<table>
        <tr><td><code>?rotate=1</code></td><td>Rotates the overview and each department (boss mode); <code>&amp;sec=30</code> seconds per page</td></tr>
        <tr><td><code>?dept=Network</code></td><td>One department only (department head mode)</td></tr>
        <tr><td><code>&amp;tv=1</code></td><td>Wall mode: larger text, no buttons or cursor</td></tr>
      </table>The top also switches between all work, ops only and a single project.` },
      { h: 'Clicking through', b: 'Click a status, department, person or project to filter; ↗ opens the same cards on the board (sign-in required, subject to your permissions).' },
    ],
  },
  {
    id: 'sync', icon: 'refresh', title: 'Windows portable and sync',
    intro: 'The Windows connected edition is still in development. The portable edition works offline and syncs both ways with your account once connected to the server.',
    items: [
      { h: 'Connecting', b: 'Click the sync badge in the header (“Local”) and enter the server URL and your AD credentials, or “Sign in with the browser” and confirm the code there. Guest accounts cannot connect.' },
      { h: 'Sync status', b: 'The badge shows “Synced”, “Syncing”, “Offline · N pending” or “Conflict”. While the server is reachable, local changes go up within about a second and others\' changes come down at once; offline changes queue and are sent when the connection is back. “Sync now” forces it.' },
      { h: 'Conflicts', b: 'When both sides change the same field, the later one wins and both versions are kept; in the sync panel\'s “Conflicts”, choose “Use mine” or “Use theirs”. Changes to different fields are not conflicts.' },
      { h: 'Updates', b: 'After connecting, the version is checked automatically; if it differs from the server, “Updating IPMS” appears and the page reloads after a few seconds, with your data untouched. If new components are needed you are asked to run the full installer.' },
      { h: 'Window', b: 'There is no black console window; closing the IPMS window ends the program after about 5 seconds.' },
    ],
  },
  {
    id: 'accounts', icon: 'users', title: 'Accounts and permissions',
    items: [
      { h: 'Roles', b: `<table>
        <tr><td>System admin</td><td>All admin settings; all cards</td></tr>
        <tr><td>Board admin RW</td><td>Can see, change and assign every card</td></tr>
        <tr><td>Board admin RO</td><td>Can see every card; changes only their own, comments on others</td></tr>
        <tr><td>Department admin RW</td><td>Manages their departments\' cards + their own (assigns only within the department)</td></tr>
        <tr><td>Department admin RO</td><td>Sees their departments\' cards + their own; changes only their own, comments on others</td></tr>
        <tr><td>User</td><td>Cards they created, are assigned or are @mentioned on (cannot assign)</td></tr>
        <tr><td>Guest</td><td>Only the public portal links, waiting for an administrator</td></tr>
      </table>A card belongs to the departments of its creator and assignees (AD “department”).` },
      { h: 'Managers and reports', b: 'Managers come from AD\'s “manager” attribute by default (administrators can override), across several levels. Managers see all their reports\' cards (marked “Report”) and, depending on the setting, can edit and assign to reports, or only view and comment.' },
      { h: 'Language and personal settings', b: '“EN / 中” in the header switches the language, saved to your account; other personal settings (favorites, layouts, view choices) are stored on the server too.' },
    ],
  },
  {
    id: 'admin', icon: 'settings', title: 'Admin console (administrators)',
    intro: 'Open /admin, or click the logo or the clock 5 times quickly; on the server it is also in the account menu. Only system admins can enter.',
    items: [
      { h: 'Content', b: 'Tree editor for public folders and links: drag to reorder or into folders; name, URL, description, icon, color, open in new tab, enabled, and <b>visibility</b> (everyone, or chosen departments / people; a folder\'s limit applies to everything inside).' },
      { h: 'Home layout, quick links, icons', b: 'Add, order and configure Home sections; grouped quick links; upload icons, rename them (references update automatically) and see how often they are used.' },
      { h: 'Appearance and settings', b: 'Site name, default language, theme and accent color, background, clock style, feature switches, and board settings: due-soon days, <b>how long after closing a card moves to History</b>, manager rights, workload thresholds, people-load limit, shared windows, tag colors and what the war room shows.' },
      { h: 'Backup and import', b: 'Automatic backups (weekly full, incremental every few hours, retention days), back up now, download, upload and restore; every backup checks that the database and attachments match. Also whole-site JSON export / import and demo data for testing.' },
      { h: 'Accounts and permissions', b: 'AD accounts appear here after their first sign-in, as guests; promote them to user or admin, set managed departments and managers, or disable accounts. At least one AD system admin must remain.' },
      { h: 'System settings', b: 'AD / LDAP connection (with tests), Entra ID, sign-in security (timeouts, lockout), HTTPS certificate, ports, Microsoft Teams notifications (channels, change digests, daily project events, system and hardware alerts, scheduled status reports).' },
      { h: 'API docs', b: '“API docs” at the bottom left of the console, or /docs: every API grouped by feature with descriptions, and you can try them out (running as yourself).' },
    ],
  },
];

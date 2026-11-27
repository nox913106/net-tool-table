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
    id: 'numbering', icon: 'list', title: 'Card numbering',
    intro: 'A card and every level of work under it are numbered. The outline in the card, the project page list, the Excel report, the Gantt sheet and the MS Project file all use the same rule.',
    items: [
      { h: 'The levels (as in OpenProject)', b: `<table>
        <tr><td><b>Project / main card</b> (the card itself, the head of the project)</td><td>no number — just its title</td></tr>
        <tr><td><b>Phase</b> (first level under the card)</td><td><code>A</code>, <code>B</code>, <code>C</code> … <code>Z</code>, <code>AA</code> … (how many depends on the project's size and detail)</td></tr>
        <tr><td><b>Work</b> (under a phase)</td><td><code>A1</code>, <code>A2</code> … (a phase can hold its own milestones)</td></tr>
        <tr><td><b>Sub-work</b></td><td><code>A1-1</code>, <code>A1-2</code> …</td></tr>
        <tr><td><b>Detail</b></td><td><code>A1-1.1</code>, <code>A1-1.2</code> …; each deeper level adds <code>.n</code>: <code>A1-1.1.1</code></td></tr>
      </table>` },
      { h: 'Each card has its own numbers', b: `<ul>
        <li>Numbers start again at A in every card (project); the card itself has none.</li>
        <li>Where many cards are listed together (the board's Gantt, a report of several cards), the numbers sit under their own card, so the card tells you which A it is.</li>
        <li>Collaborator rows (co-assignees or @mentioned people without a subtask of their own) are numbered after the phases in the report, e.g. A and B are phases and C a collaborator.</li>
      </ul>` },
      { h: 'Numbers follow the order', b: 'Numbers are worked out from the current order, they are not fixed codes: reorder in the outline, or add or delete items, and the numbers after them change. To point at an item outside the system for good, use the report\'s “System ID” column (T12 card, S45 subtask, C7 collaborator).' },
      { h: 'Predecessors and importing', b: `<ul>
        <li>The report's “Predecessors” column uses numbers within the same card, e.g. “A1-2, B1 (+2 days)”; items in other cards or outside the report are written by name in 「…」.</li>
        <li>When you insert a row in Excel, its number says which level it is and where it belongs (in the nearest card above it): the parent of <code>A2</code> is <code>A</code>, the parent of <code>A2-3</code> is <code>A2</code>. The parent row must come before it.</li>
        <li>Files exported by older versions (with the card itself numbered A, or numbers like 1, 1.2, 1.2.3) still import.</li>
      </ul>` },
    ],
  },
  {
    id: 'cardface', icon: 'kanban', title: 'Cards on the board (the card face)',
    intro: 'Every mark on a card, top to bottom, means something; hover over it for the full text.',
    items: [
      { h: 'Cover and title row', b: `<ul>
        <li><b>Cover</b>: the card's first image attachment.</li>
        <li><b>🚩 Flag</b>: high priority.</li>
        <li><b>“Report”</b>: a card of someone who reports to you (only shown to managers); hover to see whether you can view and comment or also edit.</li>
        <li><b>Tags</b>: coloured tags; click one to show only cards with it.</li>
      </ul>` },
      { h: 'Project card block', b: `<ul>
        <li><b>◇ Project</b>: a project card — clicking it opens the project page, not the editor.</li>
        <li><b>#N</b>: the project's priority set by management.</li>
        <li><b>N days behind / N days ahead / On time</b>: progress against the baseline.</li>
        <li><b>Problems N</b>: items that are overdue, blocked, in schedule conflict, waiting on another project, in a window conflict or overloaded; hover for the breakdown.</li>
        <li><b>◆ name m/d</b>: the next milestone. The bar and percentage are the whole project's completion.</li>
        <li><b>My work in this project: N ›</b>: items in the project assigned to you.</li>
      </ul>` },
      { h: 'Project link, blocked and description', b: `<ul>
        <li><b>↳ project name</b>: this everyday card belongs to a project; click to open the project page.</li>
        <li><b>⛔ Blocked N days: reason</b>: a red bar, and the card gets a red frame; hover to see who flagged it.</li>
        <li>The first lines of the description show on the card.</li>
      </ul>` },
      { h: 'Date and state marks', b: `<table>
        <tr><td>▶ Starts tomorrow / in N days / on a date</td><td>Before the start date</td></tr>
        <tr><td>▶ Should start</td><td>The start date has come but the status is still New</td></tr>
        <tr><td>🕒 Due on a date</td><td>Due date still far off (closed cards show their due date too)</td></tr>
        <tr><td>🕒 Due in N days / tomorrow / today</td><td>Due soon (how many days counts as soon is set by an admin, default 2)</td></tr>
        <tr><td>🕒 N days overdue / Overdue (time)</td><td>Past due and not closed, in red</td></tr>
        <tr><td>🔁 Every Monday …</td><td>A recurring card's rule</td></tr>
        <tr><td>🔔</td><td>A reminder is set (hover for when)</td></tr>
      </table>` },
      { h: 'Counts and the progress bar', b: `<ul>
        <li><b>✓ x/y</b>: subtasks done / subtasks (canceled ones not counted), green when all are done; hover for %, hours and the period.</li>
        <li><b>🕒 Timing</b>: you are timing a subtask of this card.</li>
        <li><b>🖼 N</b>: images; <b>📎 N</b>: documents (hover for names).</li>
        <li><b>Progress bar %</b>: (done subtasks + collaborators marked done) ÷ (subtasks not canceled + collaborators).</li>
      </ul>` },
      { h: 'People row', b: `<ul>
        <li>Left: <b>💬 N</b> comments, who is on the card: “creator and N others” when the creator is one of them, otherwise “N responsible” (hover for all names).</li>
        <li>Right: assignees' avatars (up to 4); with nobody assigned, the creator (faded).</li>
      </ul>` },
      { h: 'Task tree button “Subtasks x/y · Collaborators x/y ⧉”', b: 'Opens the task window (see “Task window”). In the expanded tree each subtask shows status, assignee, due date and hours; each collaborator has a “Done” box (the collaborator or anyone who can edit the card can tick it), which counts toward completion. Double-click the tree to open the card editor.' },
      { h: 'In focus mode', b: 'When you focus on someone, cards they take part in but do not lead have a dashed frame, a “Collaborator · Lead: …” header, and a line saying what they do there, e.g. subtask “…”.' },
      { h: 'Working with a card', b: `<ul>
        <li><b>Click</b>, or select it and press <kbd>Enter</kbd>: open the editor (a project card opens its project page).</li>
        <li><b>Drag</b>: to another column = change status, up or down in a column = reorder. Read-only cards cannot be dragged.</li>
        <li><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+click: start selecting with this card; while selecting, click a card or press Space to toggle it.</li>
        <li>“+ New card” at the bottom of a column: type a title and press <kbd>Enter</kbd> to add it to that column (you can keep adding), <kbd>Esc</kbd> to cancel; “More settings…” opens the full form with the title filled in.</li>
        <li>Hovering a read-only card says “Read-only: you can view and comment”.</li>
      </ul>` },
    ],
  },
  {
    id: 'card', icon: 'edit', title: 'Card editor: every field',
    intro: 'Click a card to open its editor. Below, every field, button and option from top to bottom. The fields at the top take effect when you press Save; attachments, blocked, the baseline, comments and subtasks are saved the moment you use them.',
    items: [
      { h: 'Title', b: 'Required, up to 200 characters. Pressing <kbd>Enter</kbd> in the title saves (or adds, for a new card).' },
      { h: 'Description', b: 'Details, links, notes; optional. Type <code>@</code> to pick a colleague: they become a collaborator, can see the card and are notified.' },
      { h: 'Tags', b: `<ul>
        <li>Type a name and press <kbd>Enter</kbd> or a comma; a leading <code>#</code> is optional.</li>
        <li><kbd>Backspace</kbd> in the empty box removes the last tag; × on a tag removes it.</li>
        <li>“Frequent:” below lists tags in use; click one to add it. Suggestions also pop up while typing.</li>
        <li>Up to 8 per card, 24 characters each; case does not matter. A name always has the same colour (admins can set it).</li>
      </ul>` },
      { h: 'Type: Everyday (ops) / Project', b: `<ul>
        <li><b>Everyday (ops)</b>: daily work. A <b>Project</b> drop-down appears: pick a project and the card also shows in that project's Gantt and project board; “No project” removes it.</li>
        <li><b>Project</b>: has its own project page (Gantt, project board, list) and appears as a project card on the board. A project cannot belong to another project.</li>
      </ul>` },
      { h: 'Attachments', b: `<ul>
        <li>“Add files”, or paste (<kbd>Ctrl</kbd>+<kbd>V</kbd>) or drop files on the window (dropped on the comments they go to a comment). An existing card saves them at once; a new card uploads them after “Add”.</li>
        <li>Images: PNG, JPG, GIF, WebP, up to 10 MB each, shown as thumbnails; the first is the card cover; click for full screen, <kbd>←</kbd><kbd>→</kbd> to browse, <kbd>Esc</kbd> to close.</li>
        <li>Documents: PDF, Word, Excel, PowerPoint, md, json, yaml, toml, txt, py, rs, mermaid, up to 25 MB each. PDF and text open in the browser, Office files download.</li>
        <li>× on a thumbnail removes it (after asking). Only people who can see the card can open its files; the server checks each file's content.</li>
      </ul>` },
      { h: 'Assignees', b: `<ul>
        <li>Type a name or account and pick from the list; several people can share a card. × next to an avatar removes them.</li>
        <li>Only people allowed to assign (board admins, department admins, managers) see the box; otherwise it says “Unassigned (only admins can assign)”.</li>
        <li>A new card with nobody assigned is assigned to you.</li>
      </ul>` },
      { h: 'Status', b: `Eight choices: <table>
        <tr><td>Recurring</td><td>A card with a repeat rule, waiting for this round to close</td></tr>
        <tr><td>Overdue</td><td>Past due and not closed; one-off cards are moved here automatically, and once you move one elsewhere it is not moved back</td></tr>
        <tr><td>New</td><td>Not started</td></tr>
        <tr><td>On going</td><td>The first time a card goes On going its actual start is recorded</td></tr>
        <tr><td>Pending</td><td>Waiting for a reply or sign-off</td></tr>
        <tr><td>On hold</td><td>Paused</td></tr>
        <tr><td>Complete</td><td>Closed; a recurring card schedules the next one; asks first if subtasks are still open</td></tr>
        <tr><td>Canceled</td><td>Dropped; not counted toward completion</td></tr>
      </table>A card with subtasks shows “the status updates by itself; you can also change it” (rules under “Summary cards”).` },
      { h: 'Priority', b: 'Low / Normal / High buttons. High shows 🚩 on cards and subtasks and ranks higher on the radar.' },
      { h: '⛔ Flag as blocked…', b: `<ul>
        <li>Write where it is stuck and who you are waiting for, then “Flag as blocked” (or <kbd>Enter</kbd>); <kbd>Esc</kbd> or “Cancel” to back out. A reason is required.</li>
        <li>Then a red bar shows “⛔ Blocked N days: reason (flagged by …)” with “Change reason” and “✅ Unblock”.</li>
        <li>Takes effect at once (no Save needed), adds a comment and notifies the card's people and the lead's manager.</li>
        <li>Anyone who can edit the card can flag or clear it; not shown on closed cards, and cleared automatically when the card closes.</li>
      </ul>` },
      { h: 'Start date', b: `<ul>
        <li>A date plus an optional time. Shortcuts: <b>Today</b>, <b>Tomorrow</b>, <b>Clear</b>.</li>
        <li>When the start date comes and the card is still New, it shows “Should start” and appears under 🔔.</li>
        <li>Cannot be after the due date; not used for milestones.</li>
      </ul>` },
      { h: 'Due date', b: `<ul>
        <li>A date plus an optional time; no time = <b>by the end of that day</b>. Shortcuts: <b>Today</b>, <b>Tomorrow</b>, <b>Next Monday</b>, <b>In a week</b>, <b>Clear</b> (clears the time too).</li>
        <li>Past due and not closed, the card turns red “N days overdue” and a one-off card moves to the Overdue column; overdue cards are summed up once a day at 09:30.</li>
        <li>Milestones and repeats need a due date.</li>
      </ul>` },
      { h: 'Schedule (Gantt): Milestone', b: 'Ticked, the item only has a due date and is drawn as ◆ on the Gantt; the start date is not used. Needs a due date.' },
      { h: 'Schedule: Predecessors', b: `<ul>
        <li>Type in “+ Predecessor” and pick any card or subtask you can see (the list says “card” or “subtask of …”). You can add several.</li>
        <li>Each one shows as a chip: “card” or “sub” + name + “+ N days”. N is how many days after the predecessor finishes this one starts; 0 = the next day, negative allowed (-365 to 365).</li>
        <li>× on a chip removes it. You cannot pick the item itself or make a loop.</li>
        <li>Starting before a predecessor finishes is a <b>schedule conflict</b>, counted in the project's problems and on the radar.</li>
      </ul>` },
      { h: 'Schedule: Shared window', b: 'Shown when admins have set up outages, maintenance windows or change freezes. The list shows each window (name, dates, how many projects it holds, or “freeze”); “No shared window” clears it. Going over the capacity or landing in a freeze is a <b>window conflict</b>. A deleted window shows as “(deleted window)”.' },
      { h: 'Schedule: Actual start', b: 'Filled in the first time the item goes On going or gets time logged; you can correct it. The Gantt draws actual progress from it.' },
      { h: 'Schedule: Baseline', b: `<ul>
        <li>Shows “Planned 12/1–12/31, 3 days late / 2 days early / on time”, or “No baseline yet”.</li>
        <li><b>Set baseline</b>: stores the current start and due dates of the card and all its subtasks as the planned dates, at once. With a baseline the button reads <b>Reset baseline</b> (asks first).</li>
        <li><b>Clear</b>: removes the baseline.</li>
      </ul>` },
      { h: 'Reminder', b: 'None, at due time, 15 minutes, 1 hour, 1 day (default), 2 days or 1 week before. Disabled without a due date. All-day cards count back from 09:00 that day. It appears under 🔔 and, if you allow it, as a desktop notification (asked the first time you save a reminder).' },
      { h: 'Repeat', b: `<ul>
        <li>Choices: No repeat, Daily, Every weekday (Mon–Fri), Weekly, Monthly, Yearly.</li>
        <li><b>Every N days / weeks / months / years</b>: shown for daily, weekly, monthly and yearly, 1–365.</li>
        <li><b>Weekday buttons</b> (Sun–Sat): shown for weekly, several allowed; none picked = the due date's weekday.</li>
        <li>Monthly follows the due date's day of the month (e.g. the 15th).</li>
        <li>The hint below spells out the rule and the next date; without a due date it warns “⚠ Repeating needs a due date” and you cannot save.</li>
        <li>At the due time (18:00 for all-day cards) a dialog asks “Close and schedule the next” or “Ask again in an hour”; dragging to Complete also schedules the next. Subtasks and attachments are copied to the next card, statuses reset and dates moved on.</li>
      </ul>` },
      { h: 'Summary line and created info', b: 'Below the dates a live line reads “Start: … · Due: … (end of day) · Reminder: …”; the last line is “… created on … · completed on … · collaborators: …”.' },
      { h: 'Comments and subtasks', b: 'An existing card has “Comments and subtasks (N)” in its lower half: the subtask summary and outline on top, then the threads and subtasks, and the comment box at the bottom. See “Subtasks (in the editor)” and “Comments, replies and @”.' },
      { h: 'Buttons at the bottom', b: `<ul>
        <li><b>Delete</b> (red): only the creator or an admin who can edit all cards; asks first; subtasks, comments, time and files go too.</li>
        <li><b>Excel</b>: exports this card (with subtasks, comments, time) as a progress report, in a format you pick.</li>
        <li><b>Task window</b>: closes the editor and opens the task window.</li>
        <li><b>Cancel</b>: close without saving (called “Close” when read-only). <b>Save</b> / <b>Add</b>: submit.</li>
      </ul>` },
      { h: 'Keyboard and closing', b: '<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> saves from any field. <kbd>Enter</kbd> in the title saves. <kbd>Esc</kbd>, × at the top right, or a click outside closes without saving.' },
      { h: 'Checks on save', b: 'An empty title, a start after the due date, a milestone or a repeat without a due date cannot be saved: a message says why and the cursor goes to that field. Setting Complete while subtasks are open asks once.' },
      { h: 'Summary cards: automatic status', b: `Once a card has subtasks it is a summary task, recalculated whenever subtasks or collaborators change: <ul>
        <li>All subtasks done and all collaborators ticked → Complete; subtasks done but a collaborator not ticked → Pending.</li>
        <li>Nothing started → New; otherwise On going > Pending > On hold (canceled ones ignored).</li>
        <li>You can still set the status or drag the card; it holds until the next subtask change.</li>
        <li>With subtasks, the card's start and due dates come from them.</li>
      </ul>` },
      { h: 'Read-only and history', b: `<ul>
        <li>Title “View card” and “🔒 Read-only: you can view and comment on this card, not change it”: every field is locked and there is no Save, but you can comment, reply and open files (e.g. read-only admins, or someone assigned a subtask looking at the main card).</li>
        <li>Title “Closed case”: the card was closed longer ago than the set time (default 72 hours), with the closing date shown; nobody can change it or comment, but threads and files still open.</li>
      </ul>` },
    ],
  },
  {
    id: 'subtasks', icon: 'layout', title: 'Subtasks (in the editor)',
    intro: 'Each subtask in the lower half of the card editor is a box whose common fields you can change in place, saved at once. Levels count from the card: the card is L1, its subtasks L2, then L3, L4 … with no limit.',
    items: [
      { h: 'Creating subtasks', b: `<ul>
        <li>On a top-level comment press “<b>✓ Make subtask</b>”: the comment becomes a subtask (its text the description); “<b>× Undo subtask</b>” turns it back into a comment (asks first; time logs are kept). Deeper subtasks cannot become comments again, only be deleted.</li>
        <li>Under a subtask press “<b>+ New L3 subtask</b>”, type a name and press <kbd>Enter</kbd> (the box stays for the next one), <kbd>Esc</kbd> to cancel.</li>
        <li>Or “+ New L2 subtask (Enter)” in the task window.</li>
      </ul>` },
      { h: 'Subtask summary (top of the section)', b: `<ul>
        <li>“✓ Subtasks x / y done” with % and a bar (canceled ones not counted).</li>
        <li>“Time logged / estimated”, “Period earliest start → latest due”, “N overdue”, “N canceled”.</li>
      </ul>` },
      { h: 'Outline (the numbered list under the summary)', b: `<ul>
        <li>Each line: number (A1, A1-1, A1-1.1 …, see “Card numbering”), status dot, name, assignee avatar, due date (red when overdue).</li>
        <li>Click a line (or select it and press <kbd>Enter</kbd>) to scroll to that subtask and flash it; if it is hidden it switches back to all comments.</li>
        <li>If you can edit: first-level lines (A1, A2 …) have a grip — drag to reorder, or select and press <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>. The order also sets the order and numbers in the Excel report and the Gantt.</li>
      </ul>` },
      { h: 'Row 1: level, status, name', b: `<ul>
        <li><b>L2 / L3 …</b>: the subtask's level.</li>
        <li><b>Status</b>: New, On going, Pending, On hold, Complete, Canceled (subtasks have no Recurring or Overdue). The subtask's assignee and editors can change it.</li>
        <li>🚩 high priority; the <b>name</b> can be edited in place — <kbd>Enter</kbd> or leaving the box saves, an empty name is put back.</li>
        <li>🔔 reminder set; the <b>due mark</b> (due today, N days overdue …).</li>
        <li><b>✎ Edit</b> (“View” without rights): opens the full subtask window.</li>
      </ul>` },
      { h: 'Row 2: assignee, start, due, estimate', b: `<ul>
        <li><b>Assignee</b>: avatar and name; “Assign / Reassign” opens a box to type a name or account (<kbd>Esc</kbd> to cancel), × unassigns. The new assignee is notified.</li>
        <li><b>Start / Due</b>: pick a date; an existing time is kept (change the time under “Edit”). With deeper subtasks they come from below.</li>
        <li><b>Estimate (hours)</b>: 0–1000, halves allowed; empty = no estimate.</li>
      </ul>` },
      { h: 'Row 3: time', b: `<ul>
        <li>“Logged X / estimate Y” and a bar, red when over the estimate; “… timing” when someone else is timing it.</li>
        <li><b>▶ Start timer</b>: shows the running time (h:mm:ss); <b>■ Stop</b> asks right away “What did you do in this time?” — correct hours, minutes and date and Save, or Skip. Closed subtasks cannot be timed; reassigning or closing stops a running timer.</li>
        <li><b>+ Log time</b>: hours, minutes, date and what you did (optional), then “Log” or <kbd>Enter</kbd>.</li>
        <li><b>Details (N)</b>: every entry — date, who, hours, note; ✎ edits the note, hours and date, 🗑 deletes (your own entries, or anyone who can edit the card; not while running).</li>
        <li>A completed subtask shows “Completed on …”.</li>
      </ul>` },
      { h: 'Link buttons on a subtask', b: `<ul>
        <li><b>Reply</b>: reply in this subtask's thread.</li>
        <li><b>Task tree (N)</b>: opens this subtask in the task window (N = items one level down).</li>
        <li><b>Make subtask / Undo subtask</b>: see “Creating subtasks”.</li>
        <li><b>🗑</b>: deletes the subtask with everything below it, its time and replies; asks first, cannot be undone.</li>
      </ul>` },
      { h: 'Deeper subtasks', b: 'Under a subtask is “Subtasks below (L3) · N”; each one has the same three rows and buttons, and so on down. Status rolls up automatically (same rules as summary cards).' },
      { h: 'The full subtask window (✎ Edit)', b: `<ul>
        <li>Fields: title, description (with @), attachments (add, paste, drop — saved at once), assignee, status, priority (low / normal / high), start and due (with optional times), reminder (same choices as cards), estimate (hours), schedule (milestone, predecessors, shared window, actual start).</li>
        <li>Below: “Time logged X / estimate Y” (timer and details live in the card's subtask section).</li>
        <li>Save, or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>; <kbd>Esc</kbd> or a click outside closes. Without rights the title is “View subtask” with “Read-only: only card editors or the subtask's assignee can change it”.</li>
      </ul>` },
      { h: 'Who can change subtasks', b: `<ul>
        <li>People who can edit the card: add, change, assign, reorder and delete at any level.</li>
        <li>A subtask's assignee: everything on their subtask except assigning it, status and time, plus adding, changing, assigning, logging and deleting below it — a higher assignee manages the whole branch.</li>
        <li>People assigned a subtask can see the main card (read-only + comments); 🔔 reminds them of their subtasks' due and overdue dates.</li>
      </ul>` },
    ],
  },
  {
    id: 'navigator', icon: 'layout', title: 'Task window',
    intro: 'A floating window where subtasks open level by level from left to right — handy for deep work breakdowns.',
    items: [
      { h: 'Opening it', b: '“Subtasks x/y ⧉” on a card, “Task window” at the bottom of the editor, “Task tree (N)” on a subtask, or a row in the project page list.' },
      { h: 'Top: path and buttons', b: 'The path (card › subtask › …) jumps back to any level; “Full edit” opens the card editor; × closes (<kbd>Esc</kbd> too).' },
      { h: 'First column: the card', b: `<ul>
        <li>The card's status, start, due, hours and progress.</li>
        <li>“Subtasks”: each subtask's (A, B …) status and name — click to open it on the right; “+ Add a subtask (Enter)” below.</li>
        <li>“Card comments (N)”: the card's own comments — comment, reply, edit, delete (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends).</li>
      </ul>` },
      { h: 'Subtask columns (A // subtask …)', b: `<ul>
        <li>Top: “More settings” opens the full subtask window (files, times, reminder); 🗑 deletes it with everything below (asks first and says how many go with it).</li>
        <li><b>Name</b> (<kbd>Enter</kbd> saves), <b>status</b> (asks first if you set Complete while items below are open), <b>assignee</b> (assign / reassign / unassign), <b>priority</b>, <b>start</b> / <b>due</b> (worked out from below when it has subtasks), <b>estimate (h)</b>, <b>schedule</b> (milestone, predecessors …).</li>
        <li><b>Description</b>: “Add description / Edit description” edits it in place.</li>
        <li><b>Time log</b>: ▶ timer / ■ stop, log (hours, minutes, date, note), edit or delete each entry.</li>
        <li><b>Comments (N)</b>: this subtask's thread.</li>
        <li><b>Subtasks below (L3)</b>: the list and “+ New L3 subtask (Enter)”; click one to open it further right.</li>
      </ul>` },
      { h: 'Focused expanding', b: 'One item per level is open at a time: clicking another subtask folds the previous one; clicking the same one again folds it. Every change is saved at once.' },
    ],
  },
  {
    id: 'comments', icon: 'message', title: 'Comments, replies and @',
    intro: 'Every card and every subtask can have comments and replies.',
    items: [
      { h: 'The comment box', b: `<ul>
        <li>Type and press “Send” or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>. Files alone, without text, can be sent too.</li>
        <li>📎, paste, or drop files on the comments: they show above the box (× to drop one) and can be sent once uploaded.</li>
      </ul>` },
      { h: 'Replies', b: '“Reply” on a comment opens a reply box (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends, <kbd>Esc</kbd> cancels). Replying to someone\'s reply @mentions them and notifies the whole thread.' },
      { h: 'Editing and deleting', b: 'Your own comments have “Edit” (shows “(edited)” afterwards; <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves, <kbd>Esc</kbd> cancels) and 🗑 delete; with replies, or on a subtask, it asks first and deletes the replies too.' },
      { h: '@ mentions', b: 'Type <code>@</code> for a list (yourself, then managers / reports / peers first; you can @ yourself); the person picked can see the card and is notified. With AD reachable you can also @ people who have never signed in. Mentions are always saved as <code>@username</code>: typing <code>@Full Name</code> without picking is changed to the username (left as typed when several people share the name; pick from the list then). A person picked is a name bubble in the box (hover for the username); Backspace / Delete removes the whole bubble, so one stray key cannot break or change the mention. Comments, descriptions and cards show mentions as name bubbles too.' },
      { h: 'Sort and filter buttons', b: 'Top right of the comments: “🕒 Oldest first / Newest first” and “✓ All comments / Subtasks only” (in outline order). Your choice is kept on your account.' },
      { h: 'When read-only', b: 'Read-only people can still comment, reply and attach files; read-only admins cannot change the card\'s files but can attach files to comments. Closed cases take no comments.' },
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
        <li><b>Gantt</b> (this project and the cards that belong to it), <b>project board</b> (work at every level by status; drag to change status), <b>list</b> (numbered as in “Card numbering”: the project itself A, below it A1, A1-1, A1-1.1 …).</li>
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
    id: 'ai', icon: 'sparkles', title: 'AI assistant',
    intro: '“AI assistant” in the sidebar and “AI suggestions” in the card editor. They appear once an administrator enables at least one usable service under “AI services”. Only work you can see is sent to the AI.',
    items: [
      { h: 'Scope', b: '“My work” (cards you lead or collaborate on, or with subtasks assigned to you), “Project” (one project with the cards that belong to it), or “Everything I can see”. The project page\'s “AI assistant” button opens it for that project.' },
      { h: 'Progress summary', b: 'Overall progress (share done, on schedule or not, the one thing to watch), where each main piece of work stands, risks and things to note.' },
      { h: 'What to do about blocked or overdue items', b: 'Each blocked or overdue item: likely causes, concrete steps, whether to move the due date or escalate — ordered by impact; then overall adjustments.' },
      { h: 'This week (done / not done)', b: 'What was finished and what was not this week (Monday to Sunday), with where the unfinished ones are stuck and when they should finish, plus notes for next week.' },
      { h: 'Suggested plan for next week', b: 'Next week\'s work <b>from highest to lowest priority</b> as a table (priority, number, item, owner, suggested time, reason), and what can wait. Overdue items, blockers of later work, milestones and high priority come first.' },
      { h: 'Lists to check against', b: 'Under every report are lists computed by the system (done this week, not done this week, overdue, blocked, candidates for next week) — not by the AI — to check its text against. The number tiles at the top are computed too.' },
      { h: 'Generate a project', b: `<ul>
        <li>Enter the name, start date, target finish (optional), how many levels, and the requirements and scope (equipment, quantities, windows, acceptance… the more specific the better), then “Generate project plan”.</li>
        <li>The AI plans main tasks, subtasks and a schedule, each with <b>suggested content</b>, an <b>execution flow</b> and the <b>screenshots to keep</b>. Click an item to read it; unticked items (and everything below) are not created; you can rename the project.</li>
        <li>“Create project” creates the project card and its subtasks (dates from the start date, sign-offs as milestones), each with its content, flow and screenshot list as its description, then opens the project page. Adjust owners and dates as usual afterwards.</li>
      </ul>` },
      { h: 'Follow-ups, more information and handing to AiPM', b: 'Under every AI answer (reports and “AI suggestions”) you can keep the conversation going: ask for details, or add what the AI didn\'t know (e.g. “point 2 is already done”, “the vendor slipped to 12/20, please re-plan”); the AI corrects itself, says what changed, and lists what it still needs you to decide. Each follow-up re-reads what you can see now, never anything you have no access to.<br>“Hand to AiPM as project actions”: AiPM turns the conversation into concrete changes (waiting for the owner\'s or a board manager\'s approval), items to track and questions to the people involved; a project report goes to that project\'s AiPM, a “my work” or “everything” report to “My AiPM”, which sorts it into projects. AiPM changes nothing by itself.' },
      { h: '“AI suggestions” on cards and subtasks', b: 'At the bottom of the card editor and the subtask window: suggested content (with a definition of done), an execution flow (risky steps with checks and how to roll back) and the screenshots to keep (which step, what to capture, what must be visible, a file name). “Add to description” appends it; remember to save.' },
      { h: 'Several models', b: 'With routing set to “parallel”, each AI service\'s answer has its own tab to compare; when generating a project each model\'s plan can be picked. With “fallback” you see the first service that answered and which ones were skipped. Every answer shows cloud or on-prem, model, time and tokens.' },
      { h: 'Note', b: 'AI output is for reference; check it before using it. It only knows what is in the system and general practice, and may get things wrong.' },
    ],
  },
  {
    id: 'aipm-my', icon: 'message', title: 'My AiPM (work secretary)',
    intro: '“My AiPM” in the sidebar is everyone\'s work secretary and project manager, and the main way to work with the system: talk to it, paste screenshots or meeting notes, and it records, organises, follows up and remembers, so you need not take notes or recall meetings. Boards and Gantt charts show those records.',
    items: [
      { h: 'Chat', b: `<ul>
        <li>Just say what happened: what you did, what you ran into, what is next, who you need; paste or drop screenshots (up to 6). Several things in one message is fine.</li>
        <li>AiPM works out which item each part belongs to and lists them under “To record on these items”: change the item or text, tick and press “Record on items” to record them as <b>your</b> comments on those items (with the screenshots). When it cannot tell where something belongs, it asks you first.</li>
        <li>Changes it suggests (dates, status, owner, new work…) go to that project\'s AiPM and wait for the project lead or a board administrator; things to chase go to that project\'s follow-ups.</li>
      </ul>` },
      { h: 'Ask about the past', b: 'For example “What did we decide with the vendor last week?” or “What problems has this switch had before?”: AiPM answers from meeting minutes, comments and what you told it, citing sources (M = meeting, C = comment, P = what you said). It only searches cards you can already see, and says so when it finds nothing.' },
      { h: 'Daily check-in', b: 'At the daily patrol time (08:30 by default) everyone with work in progress gets a private message and notification listing their own items, with overdue, due today, due soon and blocked marked. Reply with what you did, what is next and what is blocking you; AiPM records it on the items. Only to that person, only their items; administrators can turn it off.' },
      { h: 'Meetings', b: 'No recording: after a meeting paste the notes, transcript or key points under “Meetings” and press “Write the minutes”. AiPM writes a summary, attendees, discussion, <b>decisions</b>, <b>action items</b> (owner, due date) and open questions. Action items become suggested new work for the project lead or a board administrator to approve; the writer records the related entries with one click. Minutes are visible to the writer and to people who can see every card involved.' },
      { h: 'Closure alignment', b: 'When an item is finished, AiPM asks the person responsible (or, without one, the project lead or a board administrator) to align it under “Closure alignment”: check the description, completion criteria and screenshot or file records, write a closure summary (“Draft with AiPM” writes a first draft), and press “Align” — the summary is kept as a comment on the item. <b>Closing is never blocked</b>; items not yet aligned are flagged in the project\'s AiPM under “What the system detects”.' },
      { h: 'Today\'s work', b: 'On the right: your items in progress, blocked and overdue first; click one to open its project\'s AiPM.' },
    ],
  },
  {
    id: 'aipm', icon: 'sparkles', title: 'AiPM (AI project manager)',
    intro: 'AiPM is each project\'s AI project manager, for every department (administration, management, PM, infrastructure, R&D, purchasing…): members just <b>paste screenshots and say a sentence or two</b>; AiPM reads the whole project with that field\'s expertise, forecasts what is likely to happen, asks for what is missing and suggests notes, completion criteria, screenshot lists and follow-ups, so everyone can focus on their own work. An administrator turns on AI and AiPM under “AI services”.',
    items: [
      { h: 'Where to open it', b: 'The “AiPM” button on a project page, “AiPM” at the bottom of the card and subtask editors (that item is preselected), AiPM notifications in the bell, and “AiPM to do” at the top of the AI assistant page. For a card that belongs to a project, AiPM works on the whole project.' },
      { h: 'Chat: paste, then describe', b: `<ul>
        <li>Under “About”, pick the item the note is about (A, A1, A1-1, A1-1.1…).</li>
        <li>Paste (Ctrl+V) or drop screenshots, up to 6, or press “Screenshot”; write a sentence or two: what is done, what you ran into, what is next. Press “Send” or Ctrl+Enter.</li>
        <li>With “Also keep as a comment” (the default) the text and screenshots become a comment on that item, so the record stays where it belongs.</li>
        <li>AiPM answers with <b>my understanding</b> (what it sees in the note and screenshots), its assessment and what to watch, and a <b>forecast and risks</b> (high / medium / low, marked as estimates).</li>
      </ul>` },
      { h: 'Who sees screenshots', b: 'Screenshots go only to AI services an administrator marked “can see images”, and by default only to <b>on-premises</b> ones; sending them to the cloud needs “Allow screenshots to be sent to cloud services”. Without such a service the screenshots are still kept in the comment and AiPM works from the text (the header says “cannot see screenshots”).' },
      { h: 'AiPM\'s questions', b: 'Up to 3 precise questions at a time, each with why it matters and options to click; the person who should answer (by default the item\'s owner) is notified. <b>Answer several at once</b>: clicking an option (click again to unpick) or typing only fills the answer in and locks nothing; when ready, press “Send N answers to AiPM together” below — each answer is kept as a comment on its item and AiPM adjusts once with all of them. You can also answer only some; the rest stay. Only the person asked (or the project lead or a board administrator) can answer or skip; others see “waiting for … to answer”.' },
      { h: 'Notifications only for those concerned (no exceptions)', b: 'AiPM notifies only the person a notice is for: a question only the person asked, “changes waiting for your approval” only the project\'s approvers — and only if that account can already see the card. In the AiPM panel everyone sees only the messages and items about cards they can see.' },
      { h: 'Suggested changes (hard rule: approval required)', b: `<ul>
        <li>AiPM <b>never changes anything by itself</b>. Added notes (completion criteria, screenshot lists, cautions), new work, dates, status, owner, priority and marking blocked are all listed under “Suggested changes (awaiting approval)”.</li>
        <li><b>The one exception: starting work on its start date</b> (can be turned off in admin; on by default). At the morning patrol, work whose start date is today and is still “New” moves to “Ongoing”, so nothing is left unstarted. Only New → Ongoing; an item with subtasks follows its subtasks and is not changed directly; projects themselves and closed work are left alone. Each one is listed under “Approved changes (can be undone)”, the people on it are notified, and “Undo” puts it back.</li>
        <li>Only the <b>project lead</b> (the project card\'s owner) or a <b>board administrator</b> (board administrator RW, or a department board administrator RW of the project\'s departments) can “Approve”, “Skip” or later “Undo”; others see “awaiting approval”. Approvers are notified of new suggestions.</li>
        <li>AiPM never suggests or applies changes to items that are complete or canceled.</li>
        <li>Notes are added at the end of the description (marked 【AiPM】 with the date, nothing overwritten) and cannot be undone once the description has been edited again. Approved changes run with the approver\'s permissions.</li>
      </ul>` },
      { h: 'Follow-ups', b: 'Things AiPM thinks need chasing (a vendor reply, a change window, a check after go-live…), with a date. Press “Done” or “No need”; AiPM also closes the ones that are done when it next reviews.' },
      { h: 'What the system detects', b: 'Computed by the system, not the AI: overdue, due soon but not started, blocked, milestones within 7 days, in progress with no update for 5+ days, no owner, no due date, no estimate, no description, done without any screenshot or file, and how far behind plan. AiPM gets these as evidence too.' },
      { h: 'AiPM reviews on its own', b: 'Without being asked: after a project changes (checked every 10 minutes, at most every 30 minutes per project, once changes have settled for 10 minutes) and at the daily patrol time (08:30 by default, set by the administrator) it reviews active projects, leaves suggestions for approval and questions, and notifies only those concerned. On-hold, finished, canceled and History projects are skipped. “Ask AiPM to review” runs it any time.' },
      { h: 'Note', b: 'AiPM only knows what is in the system and what you tell it, and marks guesses as estimates; important changes always need a person. Projects in History are read-only.' },
    ],
  },
  {
    id: 'export', icon: 'download', title: 'Export and import (Excel, MS Project)',
    items: [
      { h: 'Where to export', b: 'Board “Select / export” then “Export report”; “Excel” in the card editor; “Excel report” on a project page; “Export” on the Gantt toolbar; “Export Excel” in History; “Export by person…” on the board.' },
      { h: 'Three formats', b: `<ul>
        <li><b>Progress report (Excel)</b>: a tree (cards A, B …, below them A1, A1-1, A1-1.1 … — see “Card numbering”; folded with Excel\'s ＋ / − on the left) with status, dates, % complete, milestone, predecessors, estimated / actual hours, latest progress and time details; plus “Projects”, “People load” and “Problems” sheets. Printing is set up (A4 landscape, repeated headers).</li>
        <li><b>Report + Gantt (Excel)</b>: adds a “Gantt” sheet with status-colored bars, milestones, today and baseline, printed on A3 landscape; scale auto, day, week or month.</li>
        <li><b>MS Project (XML)</b>: opens directly in Microsoft Project or ProjectLibre, keeping levels, predecessors and gaps, milestones, baseline and assignees.</li>
      </ul>` },
      { h: 'Export by person', b: 'Tick people or a whole department, optionally limit by status and ops / projects, and export every card they take part in; by default only their own subtasks are listed (cards they own or co-own are listed in full).' },
      { h: 'Import report', b: `<ul>
        <li>“Import report…” takes an exported Excel file: change status, dates, assignees, estimates, milestones (◆ / yes to set, no to clear) and predecessors in Excel, or insert rows (empty system ID = new, its parent found from its number — the parent of A2-3 is A2; files with old 1.2.3 numbers import too).</li>
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
    id: 'accounts', icon: 'users', title: 'Accounts',
    items: [
      { h: 'Roles', b: `<table>
        <tr><td>Board admin RW</td><td>Can see, change and assign every card</td></tr>
        <tr><td>Board admin RO</td><td>Can see every card; changes only their own, comments on others</td></tr>
        <tr><td>Department admin RW</td><td>Manages their departments\' cards + their own (assigns only within the department)</td></tr>
        <tr><td>Department admin RO</td><td>Sees their departments\' cards + their own; changes only their own, comments on others</td></tr>
        <tr><td>User</td><td>Cards they created, are assigned or are @mentioned on (cannot assign)</td></tr>
        <tr><td>Guest</td><td>Only the public portal links, waiting for an administrator</td></tr>
              <tr><td>+ System admin</td><td>An extra identity any level except guest can be given: the admin console only (settings and queries), no extra board rights — e.g. “User + System admin” still sees just their own cards on the board</td></tr>
      </table>A card belongs to the departments of its creator and assignees (AD “department”).` },
      { h: 'Managers and reports', b: 'Managers come from AD\'s “manager” attribute by default (administrators can override), across several levels. Managers see all their reports\' cards (marked “Report”) and, depending on the setting, can edit and assign to reports, or only view and comment.' },
      { h: 'Language and personal settings', b: '“EN / 中” in the header switches the language, saved to your account; other personal settings (favorites, layouts, view choices) are stored on the server too.' },
    ],
  },
  {
    id: 'admin', icon: 'settings', title: 'Admin console (administrators)',
    intro: 'Open /admin, or click the logo or the clock 5 times quickly; on the server it is also in the account menu. Only accounts with “System admin” (and the local admin) can enter. Every setting applies on save, with no need to sign in to the host, and every change is recorded in the audit log.',
    items: [
      { h: 'Two groups on the left', b: '<b>Portal</b>: content, home layout, quick links, icons, appearance and settings. <b>System settings</b> (the same tabs as the CFXD daily report system): status, AD sign-in, accounts, audit log, backup & restore, HTTPS certificate, notifications, system info, versions. When the health check has failed items, a red bar at the top of every page links to “System status”.' },
      { h: 'Content', b: 'Tree editor for public folders and links: drag to reorder or into folders; name, URL, description, icon, color, open in new tab, enabled, and <b>visibility</b> (everyone, or chosen departments / people; a folder\'s limit applies to everything inside).' },
      { h: 'Home layout, quick links, icons', b: 'Add, order and configure Home sections; grouped quick links; upload icons, rename them (references update automatically) and see how often they are used.' },
      { h: 'Appearance and settings', b: 'Site name, default language, theme and accent color, background, clock style, feature switches, and board settings: due-soon days, <b>how long after closing a card moves to History</b>, manager rights, workload thresholds, people load limits, shared windows, tag colors, what the war room shows.' },
      { h: 'System status', b: `<ul>
        <li><b>Health check</b>: grouped by storage / hardware / system / services / settings / background work / version; every item is OK, warning or failed with its value, and anything not OK has “→ how to fix” below it. Top right: when it ran and the counts.</li>
        <li><b>Check now</b>: runs everything again (including AD, Entra and database integrity); it also runs every hour.</li>
        <li><b>Recent maintenance</b>: recent backups (with their database / attachment check), certificate or port changes, upgrades.</li>
        <li><b>Decided at install time (read only)</b>: version, program / data / icon / backup locations, ports and server name.</li>
      </ul>` },
      { h: 'AD sign-in', b: 'AD / LDAP connection (server, base DN, service account, domain, group filter, advanced attributes and TLS — test before saving), Microsoft Entra ID sign-in, and sign-in security (idle sign-out, longest session, lockout).' },
      { h: 'Accounts', b: 'AD accounts appear here after their first sign-in, as guests; give them a level (user or above), set managed departments and managers, or disable accounts. “+ System admin” next to the level adds admin-console rights (not for guests): settings and queries only, the board still follows the level. At least one AD account must keep system admin, and you cannot remove your own or disable yourself.' },
      { h: 'Audit log', b: `<ul>
        <li>Records sign-ins / failed sign-ins / sign-outs, account permission changes, every system setting, backups (now, download, upload, delete, restore), HTTPS certificate and ports, appearance settings, portal content import / export and link changes, deleted cards, Excel report imports, demo data, standalone copies, upgrades. Each row has time, action, who, target, details and source IP; failed actions are shaded red.</li>
        <li><b>Search</b>: from / to (up to 366 days), action, who, target (contains), details (contain), failures only; quick ranges today / yesterday / last 7 / last 30 days / this month; rows grouped by day with clickable per-day counts; 100 per page with “← Newer / Older →”.</li>
        <li><b>Export CSV</b>: everything matching (opens in Excel); the export itself is recorded.</li>
        <li><b>Retention</b>: 180–3650 days (default 366), purged daily; rows cannot be changed or deleted on screen; restoring a backup keeps the audit rows newer than it.</li>
      </ul>` },
      { h: 'Backup & restore', b: 'Automatic backups (weekly full, incremental every few hours, retention days), full / incremental backup now, download, upload and restore; every backup checks that the database and attachments match. Also whole-site JSON export / import and demo data for testing.' },
      { h: 'HTTPS certificate', b: 'The current certificate (subject, issuer, names, expiry and days left), replace it by pasting or choosing files (pair and expiry checked first; rolled back if nginx refuses it), regenerate a self-signed one, and the HTTPS / HTTP ports and server name.' },
      { h: 'Notifications', b: 'Microsoft Teams channels: what each gets (card change digests, daily project events, system and hardware alerts, scheduled status reports), scope, thresholds and tests; “Send a status report now”.' },
      { h: 'AI services', b: `<ul>
        <li><b>Settings</b>: on/off; “Allow cloud services” (off = on-premises only, data stays inside); routing <b>fallback</b> (by priority, the next one on failure, budget or quota) or <b>parallel</b> (every usable service at once); timeout, max output, temperature, default system prompt.</li>
        <li><b>AI services</b>: add from a template — cloud (Claude, OpenAI, Gemini, Azure OpenAI, AWS Bedrock, Mistral, DeepSeek, xAI, OpenRouter, Groq, Together, subscriptions) or on-prem (Ollama, vLLM, LM Studio, llama.cpp, LocalAI, a company AI gateway). Each has a model, URL, key (stored encrypted), priority, billing and prices, a budget or token quota per period and extra parameters; the list shows calls and cost this period and why a service is unavailable, with an on/off switch.</li>
        <li><b>Test</b>: checks the connection with a fixed short sentence (no company data) and shows the reply, model and time.</li>
        <li><b>Playground</b>: type a question, pick services, choose fallback or parallel comparison; every model's answer, time, tokens and cost appear side by side.</li>
        <li><b>Recent calls</b>: service, model, purpose, result, tokens, cost and time of each call. Adding, changing, deleting and testing services is recorded in the audit log.</li>
      </ul>` },
      { h: 'System info', b: 'Read fresh each time: hardware (CPU, memory, disks), operating system (version, boot time, time zone and time sync), runtime and tools (program version, Python, SQLite, nginx, git…), file systems (which disk holds the program, data, attachments, icons and backups and how full it is), services, system packages and Python packages (checked against requirements.txt). “Download JSON” for problem reports or asset inventories.' },
      { h: 'Versions and upgrading', b: `<ul>
        <li>The running version vX.Y.Z and commit; counted from the first November commit (v1.0.0): X core architecture and major features, Y changes to existing features, Z fixes of bugs, vulnerabilities and faults.</li>
        <li><b>Upgrade</b>: lists the newer versions on GitHub with what changed; “Upgrade to the latest” has the host's upgrade service do, as root, exactly what <code>tool-table.sh upgrade</code> does (backup → update → packages → restart → health check), with progress and the log on the page and a reload when done. The first time, upgrade once with the command on the host; after that the button works.</li>
        <li><b>All versions</b>: date, commit (links to GitHub), type and changes of every version, with the running one marked.</li>
      </ul>` },
      { h: 'API docs', b: '“API docs” at the bottom left of the console, or /docs: every API grouped by feature with descriptions, and you can try them out (running as yourself).' },
    ],
  },
];

# ServerSafety

A Vencord/Equicord userplugin that reads a Discord server's permissions, tells you what
is actually wrong with them, and gives you the tools to fix it. Everything it writes to a
server is recorded and can be undone.

It is built for the person who moderates a server and does not want to click through
forty channel permission screens to find the one that was left open.

## Installing

You need an Equicord or Vencord source build. From the root of that checkout:

```bash
git clone https://github.com/Just-Me-22/ServerSafety src/userplugins/serverSafety
pnpm build
```

Then reload Discord and turn on **ServerSafety** in your plugin list. It appears on the
server right-click menu and on the dropdown you get from clicking a server's name.

## What it tells you

Open **Server Safety** on any server and it reads roughly twenty checks against what
Discord actually has configured, sorted with the dangerous ones first.

It covers the obvious things, like `@everyone` holding Administrator or Manage Webhooks,
and the ones nobody remembers setting:

- Channel overrides that hand out power the role itself never granted
- Channels that ended up more open than the category they sit in, which is what a
  half applied fix looks like
- Roles that can promote themselves, because Manage Roles hands out everything below you
- Bots running with Administrator, and bots sitting above your own staff
- Onboarding quietly giving a role with real permissions to anyone who clicks a button
- Combinations that are fine apart and a problem together, like open invites plus no
  verification plus no screening

Each finding has a button that opens the exact Discord setting behind it, so you are not
hunting through menus to act on it.

There is also a plain sentence at the top that most people find more useful than the
list: what an account that joined ten seconds ago can see and post in, right now.

## Keeping it that way

**Baselines.** Once a server is how you want it, save a baseline. From then on the tab
tells you what has moved off that state, rather than repeating things you already decided
were fine.

**Accept.** Anything you have deliberately chosen to live with can be accepted. It drops
to a collapsed list and stops counting.

**Live watch.** If a server picks up a new critical problem while you are online, you get
told. Optionally it also posts to a channel of your choosing.

**Who changed things.** Reads the audit log and says who did what, in English. A role
permission change comes back from Discord as two numbers, so it diffs them and tells you
which permissions were added or removed by name.

## Acting on it

- **Recent joins**, with account age, which invite each person came through, and flags
  for the things that matter: brand new accounts, no avatar, names that are identical
  once you strip the digits, and clusters of people arriving in the same minute
- **Per member actions**: timeout, warn by DM, quarantine, kick, ban
- **Emergency**, which raises verification, scans media, pauses invites and DMs, locks
  every channel, and can announce it, all in one press
- **Bulk changes**, to set slowmode everywhere or strip one permission off every role
  holding it
- **Broadcast**, to write a message with saved templates and see exactly how many people
  each ping reaches before you send it
- **Look around**, for the read only stuff: every webhook, the ban list, the join queue,
  who moderates, an anti raid checklist, and who can see any given channel
- **Compare roles**, side by side, including the same role across two different servers

## The undo

Every write goes into a log, which you open with **History**. One action is one entry, so
a lockdown that touched twelve channels is one undoable thing.

Undo puts back the exact values that were there rather than Discord's defaults. A channel
that had no override before gets its override deleted rather than reset to zero, because
writing an empty override is itself a change.

Before undoing, it compares the current state against what it left behind. If somebody
has edited that role or channel since, it says which ones and makes you confirm, instead
of quietly overwriting their newer work.

A kick is the only thing here that cannot be undone, and it says so before you press it.

## What it will not do

Some of this is Discord's limits rather than choices:

- A timeout cannot be longer than 28 days
- A ban has no duration at all. It stands until somebody lifts it
- A ban can only delete up to seven days of the person's messages
- Quarantine cannot hold somebody with Administrator, because Administrator ignores
  channel overrides. The plugin says so by name rather than appearing to work

Everything is also gated on your own permissions and on role hierarchy, so buttons you
could not actually use are disabled rather than failing when you press them.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Live watch | on | Tells you when a server gains a new critical problem while you are online |
| Watch spikes | off | Tells you when a channel suddenly floods with messages |
| Watch new accounts | off | Tells you when a brand new account posts a link or an invite |

The two off by default are noisier and only worth turning on if you want them.

## Permissions

Everything works with a normal account. Individual features need the matching Discord
permission and say so when you lack it, rather than showing you an empty panel. Nothing
here needs a bot.

## Licence

GPL-3.0-or-later, same as Vencord.

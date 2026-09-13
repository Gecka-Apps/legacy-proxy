# The `main` script: one active Sieve script that only includes the others

A ManageSieve server runs exactly one active script per user. Every webmail
that manages Sieve rules wants that slot: the first one to write there wins,
the next one silently switches the previous rules off, and an autoresponder
set from one client disappears when a filter is saved from another.

This convention keeps every client's rules running side by side. The active
script is a *master* named `main` that contains no rule of its own, only one
`include` per rule script (RFC 6609). Each client signs the lines it manages
with a trailing comment, and never touches a line that carries another
client's signature, or none.

## The file

```sieve
# main: the active script only activates rule scripts, through include (RFC 6609).
# Each line is one script that keeps running as long as its include is live.
# A trailing "# <client>" comment marks the line as managed by that client,
# which alone lists, edits and switches it off ("# <client> off: include ...").
# Lines without a tag belong to nobody: leave them alone.
# Do not put rules here; put them in a script of their own and include it.
require ["include"];
include :personal "roundcube"; # roundcube
include :personal :optional "vacation"; # jmap-legacy-proxy
include :personal "filters"; # jmap-legacy-proxy
# jmap-legacy-proxy off: include :personal "old";
```

- `main` is the active script. It starts with the first line above, which is
  how a client recognises a master written to the convention. The other
  header lines are for whoever opens the file by hand.
- One `include :personal "<script>";` per rule script, in the order they must
  run. `:optional` lets a script be absent without breaking the master.
- A trailing `# <client>` comment is the signature of the client managing
  the line. `<client>` is a short ASCII token the client chooses once and
  keeps: `jmap-legacy-proxy`, `roundcube`, and so on.
- A line switched off in place reads `# <client> off: include ...`. The
  script stays on the server and stays registered, it just does not run.
- A line with no signature belongs to nobody. A script found active before
  the master existed is carried this way, so it keeps running.
- `include :global` lines are the administrator's and never a rule script of
  a user.

## What a client does

1. Read the active script. If it starts with the signature line, it is the
   master; if it has any `include :personal` line, adopt it as the master
   as well (it was written by hand or by a client that predates the
   convention). Otherwise create `main` with the header, a `require
   ["include"];`, and an untagged include of the script that was active, and
   make `main` active.
2. List, edit, delete and switch on or off only the scripts referenced by a
   line carrying your own signature, live or off. Every other script on the
   server is out of reach, even when it is not included anywhere.
3. To activate one of your scripts, edit your lines: switch the previous one
   off in place, bring the target's line back or append it. To register a
   new script, append it switched off. To forget a script, drop your lines
   that reference it. Never reorder, rewrite or remove a line that is not
   yours, and keep `main` hidden from the user.
4. If a plain script already bears the name `main` and is not a master,
   rename it out of the way (`main-1`, first free) before writing yours,
   and carry it along untagged if it was active.
5. Without the `include` extension on the server there is no master: fall
   back to `SETACTIVE`, knowing that the clients then overwrite each other.

`vacation` is the autoresponder script of JMAP for Sieve (RFC 9661 §4),
included `:optional` so its absence is not an error.

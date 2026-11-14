# The /away pane in Claude Code, on the made-up runs render.sh leaves, then its Config tab. Bare /away opens it without a model call.

Set Shell bash
Set FontSize 15
Set Width 1700
Set Height 720
Set Padding 16
Set Theme "Catppuccin Mocha"

Hide
Type "clear; exec sh scripts/demo/claude.sh" Enter
Sleep 8s
Type "/away" Sleep 500ms Enter
Sleep 6s
Show
Sleep 1s
Screenshot docs/public/demo/away-pane.png
Sleep 500ms

Hide
Type "5"
Sleep 4s
Down
Sleep 1s
Show
Sleep 1s
Screenshot docs/public/demo/away-config.png
Sleep 500ms

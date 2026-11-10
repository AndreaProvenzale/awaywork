# `awaywork plan`, a night's run, then `awaywork report`, in the made-up world setup.sh builds.
Output docs/public/demo/quickstart.gif

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 600
Set Padding 16
Set Framerate 12
Set TypingSpeed 60ms
Set Theme "Catppuccin Mocha"

Hide
Type "exec sh scripts/demo/env.sh bash --norc --noprofile" Enter
Type "export PS1='$ ' && cd && clear" Enter
Sleep 500ms
Show

Type "awaywork plan" Sleep 400ms Enter
Sleep 6s
Type "q"
Sleep 300ms

Hide
Type "awaywork run >/dev/null 2>&1; clear" Enter
Sleep 8s
Show

Type "awaywork report" Sleep 400ms Enter
Sleep 3s
Down@400ms 4
Sleep 800ms
Enter
Sleep 4s
Type "q"
Sleep 800ms
Down Sleep 800ms
Type "d"
Sleep 4s
Type "q"
Sleep 1s
Type "q"
Sleep 800ms

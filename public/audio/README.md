# Background music

The app-wide background loop (see `src/components/BackgroundMusic.tsx`)
plays the file:

```
public/audio/radio-los-santos.mp3
```

That track ("Radio Los Santos") is licensed music, so the MP3 is not
committed by the tooling — drop your copy in at exactly that path and
redeploy. Until the file exists the player and its header mute button
self-hide; nothing else to configure.

Keep it a reasonably sized MP3 (a few MB): it ships with every deploy and
streams to every phone in the field.

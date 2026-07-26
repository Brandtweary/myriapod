# Myriapod

A voice agent you can talk to, with a memory that stays yours.

Speak or type, and a personal memory grows out of the conversation — kept in your own browser,
carried from one visit to the next, always in your hands.

**Live at [myriapod.ai](https://myriapod.ai)** — nothing to install, nothing to run. Bring your
own [OpenRouter](https://openrouter.ai) key and your chats run on your own credits, sent straight
from your browser.

## What it is

- **A voice agent** — you *tap* to record and tap again to send. No voice-activity detection
  deciding when you're done, so it never chimes in while you're still thinking or talks over you;
  when you want to cut a reply short, one keystroke (Ctrl+Alt+Space) does it.
- **A lexicon-based memory** — after each exchange, a few quiet background agents read what was said
  and tend a glossary of the people, things, and ideas in your world, each with a short, living
  description. You opt into it, and you can export it or wipe it whenever you like.

Beside the chat, the memory shows its work: one margin lists what it recalled for you this turn, the
other shows the background agents tending it. The remembering happens out in the open.

## Why "Myriapod"

The word 'centipede' means "hundred feet", 'millipede' means "thousand feet", and the subphylum both groups belong to, Myriapoda, means "ten thousand feet". 

A myriapod walks on many small legs. No single leg carries the animal; each one lifts, reaches, and
sets down in its turn, and the body never waits on any of them; it just keeps moving. The software
has that same gait. The conversation is the body, always going forward, and behind each exchange
comes a short line of small workers, one after another, each doing its piece of the remembering and
handing the work along. The whole thing is built to move in step with a person, turn by turn.

## How it works

Myriapod wires together a few open models, and the wiring runs in your browser. The models do the
real work: speech-to-text, the language model, and text-to-speech, each running on a server. Your
browser handles the hand-offs: it captures your voice, sends it off to be transcribed, passes the
transcript to the language model, streams the reply out to be spoken, and plays the audio back.

The memory is the one part that lives on your machine. Your browser stores it in its own local
storage, on your computer, and sends it nowhere. A small backend sits in front of the language model
to hold its key, so your browser never has to; bring your own key and your browser talks to the model
directly.

Because every model in the stack is open, you can host them yourself and run the whole thing on your
own hardware; the hosted demo just runs them for you.

### The voice loop

When you finish a turn, your speech goes to an open
[Whisper](https://github.com/SYSTRAN/faster-whisper) model and comes back as text. The language model
reads it, along with whatever the memory surfaced for you, and streams a reply that an open-weights
[Orpheus](https://github.com/canopyai/Orpheus-TTS) voice speaks aloud as it arrives, so you hear the first
words before the last are written. The reference deployment runs
[Kimi K3](https://openrouter.ai/moonshotai/kimi-k3); swapping it is a one-line change.

### The memory

The memory is a glossary: a running list of what matters across your conversations, each entry a
short description kept current as the subject comes up again. When you speak, your words are matched
against it and the descriptions that fit are handed to the model, so it answers with your world in
view.

The whole memory travels: the glossary, the running notes, and the small speech corrections it's
picked up all export to a single file, the lexicon, that you can read back another day or on another
machine.

Note that this adapts to your speech at the word level only — it does **not** fine-tune Whisper to
your voice, and it can't: acoustic training needs a corpus of your recorded audio, and none is kept
(every utterance is transcribed and immediately discarded). Fine-tuning on your own voice would mean
self-hosting and modifying the stack to retain audio first.

### The pipeline

After every turn, a handful of background agents read the exchange, each with its own task. One
keeps watch over what the memory recalled and mends any description that came out thin. One decides
what's worth holding onto and writes it down. One keeps a short account of the conversation so far,
so your next visit opens with the thread already in hand. None of them make you wait — the reply is
already on its way while they work.

## Run it yourself

Everything under the hood is open. Every model in the path has published weights, so you can stand
the whole thing up on your own hardware and answer to no hosted service. This repo is the frontend;
the model endpoints are all self-hostable:

- **STT** — an open [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server over HTTP;
  point the frontend at it with `VITE_STT_BASE`.
- **TTS** — an open-weights [Orpheus](https://github.com/canopyai/Orpheus-TTS) model streamed over a WebSocket;
  `VITE_TTS_BASE`.
- **LLM** — any OpenAI-compatible chat endpoint hosting an open-weight model, either through your own
  instance of the backend (`VITE_PROXY_BASE`) or straight to a provider with your own key in Settings.

The stock system prompt (`VOICE_SYSTEM_PROMPT` in `src/main.ts`) is written for the hosted instance,
down to the model and voice it names. If you run your own, rewrite it to fit — a local home agent,
say, may want the hardware awareness the hosted prompt has no use for.

Full setup — env vars, the metering proxy, the voice servers, and a one-box reverse proxy with TLS —
is in [`docs/self-hosting.md`](./docs/self-hosting.md).

## Stack

TypeScript on a vendored `pi-web-ui` UI layer (Lit 3, Tailwind v4, Vite), a static single-page app;
the conversation rides the `@earendil-works/pi-agent-core` agent. Architecture and internals are
documented in [`CLAUDE.md`](./CLAUDE.md).

## Development

```sh
npm install
npm run dev        # Vite dev server with HMR
npm run build      # production build (adds a strict CSP)
npm run check      # type-check
```

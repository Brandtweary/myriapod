// Build-time stub for @mistralai/mistralai.
//
// myriapod only ever drives the OpenRouter provider, so pi-ai's Mistral provider
// (dynamically imported by the provider registry, never invoked here) is dead
// weight — and it drags in optional OpenTelemetry instrumentation that would
// otherwise force `@opentelemetry/api` + `@opentelemetry/semantic-conventions`
// into the build just to satisfy rollup's static resolution.
//
// Aliasing the package to this stub (see vite.config.ts `resolve.alias`) makes
// rollup bundle this instead — the real Mistral SDK and both OpenTelemetry shims
// drop out of the production bundle entirely, and nothing phones home. The only
// value import pi-ai makes is `{ Mistral }`; the class body is never constructed
// because the Mistral code path never executes.
export class Mistral {}

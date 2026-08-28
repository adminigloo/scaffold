import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Prompting without a dependency.
 *
 * A prompt library would be nicer to look at, but this package is the first
 * thing a new machine runs and every dependency is one more thing that can be
 * unresolvable at exactly that moment. Two functions is a fair trade.
 */

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

export interface Prompter {
  text(question: string, fallback: string): Promise<string>;
  select<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    fallback: T,
  ): Promise<T>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

/**
 * Non-interactive prompter: every question resolves to its default.
 *
 * Used for `--yes`, and used automatically when stdin is not a TTY. A CLI that
 * blocks on a prompt inside CI hangs until the job times out, and the log shows
 * only the question — so the absence of a terminal has to mean "take the
 * defaults", not "wait forever".
 */
export function defaultsOnlyPrompter(): Prompter {
  return {
    async text(_question, fallback) {
      return fallback;
    },
    async select(_question, _choices, fallback) {
      return fallback;
    },
    async confirm(_question, fallback) {
      return fallback;
    },
    close() {},
  };
}

export function interactivePrompter(): Prompter {
  const rl = createInterface({ input: stdin, output: stdout });

  return {
    async text(question, fallback) {
      const answer = (await rl.question(`${question} (${fallback}) `)).trim();
      return answer.length > 0 ? answer : fallback;
    },

    async select(question, choices, fallback) {
      stdout.write(`\n${question}\n`);
      choices.forEach((choice, i) => {
        const marker = choice.value === fallback ? "*" : " ";
        const hint = choice.hint ? `  — ${choice.hint}` : "";
        stdout.write(`  ${marker} ${i + 1}) ${choice.label}${hint}\n`);
      });

      const fallbackIndex = choices.findIndex((c) => c.value === fallback) + 1;
      // Loop rather than accept-and-continue: a mistyped index here silently
      // changes which packages get installed, and the person finds out when a
      // route they expected does not exist.
      for (;;) {
        const raw = (await rl.question(`  choice (${fallbackIndex}) `)).trim();
        if (raw.length === 0) return fallback;
        const index = Number.parseInt(raw, 10);
        const chosen = choices[index - 1];
        if (chosen) return chosen.value;
        stdout.write(`  Enter a number between 1 and ${choices.length}.\n`);
      }
    },

    async confirm(question, fallback) {
      const suffix = fallback ? "Y/n" : "y/N";
      const raw = (await rl.question(`${question} (${suffix}) `)).trim().toLowerCase();
      if (raw.length === 0) return fallback;
      return raw.startsWith("y");
    },

    close() {
      rl.close();
    },
  };
}

/** Interactive only when there is a real terminal on both ends. */
export function createPrompter(interactive: boolean): Prompter {
  return interactive && stdin.isTTY && stdout.isTTY
    ? interactivePrompter()
    : defaultsOnlyPrompter();
}

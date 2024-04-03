import { ChatOpenAI } from "https://esm.sh/langchain@0.0.68/chat_models/openai";
import {
  HumanChatMessage,
  SystemChatMessage,
} from "https://esm.sh/langchain@0.0.68/schema";
import { Mutex } from "https://esm.sh/async-mutex@0.4.0";

import { Denops } from "https://deno.land/x/denops_std@v6.0.0/mod.ts";
import * as vars from "https://deno.land/x/denops_std@v6.0.0/variable/mod.ts";
import * as fn from "https://deno.land/x/denops_std@v6.0.0/function/mod.ts";
import { batch } from "https://deno.land/x/denops_std@v6.0.0/batch/mod.ts";
import outdent from "https://deno.land/x/outdent@v0.8.0/mod.ts";

interface Command {
  run: (denops: Denops, controller: AbortController) => Promise<void>;
}

class CmdHeyEdit implements Command {
  constructor(
    public readonly firstline: number,
    public readonly lastline: number,
    public readonly request: string,
  ) {}
  public static readonly cmd: "heyEdit" = "heyEdit";
  public async run(denops: Denops, controller: AbortController) {
    const indent = " ".repeat(
      (await fn.indent(denops, this.firstline)) as number,
    );
    const precontext = (
      await fn.getline(
        denops,
        Math.max(this.firstline - 20, 0),
        this.firstline - 1,
      )
    ).join("\n");
    const postcontext = (
      await fn.getline(denops, this.lastline + 1, this.lastline + 20)
    ).join("\n");
    const context = (
      await fn.getline(denops, this.firstline, this.lastline)
    ).join("\n");
    await fn.deletebufline(denops, "%", this.firstline + 1, this.lastline);
    await fn.setline(denops, this.firstline, [indent]);
    await fn.setcursorcharpos(denops, this.firstline, 0);

    const systemPrompt = outdent`
    Act a professional ${await vars.o.get(denops, "filetype")} writer for:
    - helping human to write code (e.g., auto-completion)
    - helping human to write prose (e.g., grammar/ spelling correction)

    The condition of the output is:
    - Ask no question regarding the input.
    - Must be only text according to the input.
    - Must insert line breaks for each 80 letters.
    - Must generate the concise text for any input.

    The following is the example of the input.
    <Prompt>${this.request}</Prompt>
    <PreContext>${outdent.string("\n" + precontext)}</PreContext>
    <Target>${outdent.string("\n" + context)}</Target>
    <PostContext>${outdent.string("\n" + postcontext)}</PostContext>
  `;

    const userPrompt = outdent`
    <Prompt>${this.request}</Prompt>
    <PreContext>${outdent.string("\n" + precontext)}</PreContext>
    <Target>${outdent.string("\n" + context)}</Target>
    <PostContext>${outdent.string("\n" + postcontext)}</PostContext>
  `;

    const model = await getModel(denops, indent, this.lastline);
    await model.call(
      [new SystemChatMessage(systemPrompt), new HumanChatMessage(userPrompt)],
      {
        options: { signal: controller.signal },
      },
    );
  }
}

class CmdHey implements Command {
  constructor(
    public readonly firstline: number,
    public readonly lastline: number,
  ) {}
  public static readonly cmd: "heyEdit" = "heyEdit";
  public async run(denops: Denops, controller: AbortController) {
    const indent =
      " ".repeat((await fn.indent(denops, this.firstline)) as number) + ">";
    const context = (
      await fn.getline(denops, this.firstline, this.lastline)
    ).join("\n");

    // const systemPrompt = '';
    const userPrompt = context;
    const model = await getModel(denops, indent, this.lastline);
    await model.call([new HumanChatMessage(userPrompt)], {
      options: { signal: controller.signal },
    });
  }
}

async function getModel(
  denops: Denops,
  indent: string,
  genRowFrom: number,
): Promise<ChatOpenAI> {
  const bufnr = await fn.bufnr(denops, ".");
  const mutex = new Mutex();
  // let isFirstChunk = true;
  let currentRow = genRowFrom;
  return new ChatOpenAI({
    modelName: await vars.g.get(denops, "hey_model_name", "gpt-3.5-turbo"),
    verbose: await vars.g.get(denops, "hey_verbose", false),
    streaming: true,
    callbacks: [
      {
        handleLLMStart: async (_llm, _prompts, _runId, _parentRunId) => {
          await mutex.acquire();
          await fn.appendbufline(denops, bufnr, currentRow, [
            "",
            indent + " GENERATED",
            indent,
          ]);
          currentRow += 3;
          mutex.release();
        },
        handleLLMEnd: async (_output, _runId, _parentRunId) => {
          await mutex.acquire();
          await batch(denops, async () => {
            await denops.cmd("undojoin");
            await fn.appendbufline(denops, bufnr, currentRow, [
              indent + " END",
            ]);
          });
          mutex.release();
        },
        handleLLMNewToken: async (token: string) => {
          await mutex.acquire();
          const currentLines = await fn.getbufline(denops, bufnr, currentRow);
          if (currentLines[0] === undefined) {
            console.log({ currentRow, bufnr });
          }
          const cline = currentLines?.[0] ?? "";

          const tokenLines = token.split("\n");

          const isSpaceRequired = cline.length == indent.length &&
            tokenLines[0].length > 0;

          const lines = [
            cline + (isSpaceRequired ? " " : "") + tokenLines[0],
            ...tokenLines.slice(1).map((l) =>
              `${indent}${(l.length == 0 ? "" : " ")}${l}`
            ),
          ];

          await batch(denops, async (denops) => {
            await denops.cmd("undojoin");
            await fn.deletebufline(denops, bufnr, currentRow);
            await denops.cmd("undojoin");
            await fn.appendbufline(denops, bufnr, currentRow - 1, lines);
            await denops.cmd("redraw");
          });
          currentRow += lines.length - 1;
          mutex.release();
        },
      },
    ],
  });
}

export function main(denops: Denops) {
  let controller: AbortController | undefined;
  let cmd: Command | undefined = undefined;

  // ref: ...args: never[]:  https://stackoverflow.com/questions/72960424/understanding-extends-args-unknown-unknown
  // never is bottom type while unknown is a universal set
  const createCmd = <T extends new (...args: never[]) => Command>(cls: T) => {
    return async (...args: unknown[]) => {
      cmd = new cls(...(args as ConstructorParameters<typeof cls>));
      try {
        controller = new AbortController();
        await cmd.run(denops, controller);
      } catch (e) {
        console.log(e);
      } finally {
        controller = undefined;
      }
    };
  };

  denops.dispatcher = {
    heyEdit: createCmd(CmdHeyEdit),
    hey: createCmd(CmdHey),
    abort: () => Promise.resolve(() => controller?.abort()),
  };
}

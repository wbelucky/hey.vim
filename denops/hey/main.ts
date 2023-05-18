import { ChatOpenAI } from "https://esm.sh/langchain@0.0.68/chat_models/openai";
import {
  HumanChatMessage,
  SystemChatMessage,
} from "https://esm.sh/langchain@0.0.68/schema";
import { Mutex } from "https://esm.sh/async-mutex@0.4.0";

import { Denops } from "https://deno.land/x/denops_std@v4.0.0/mod.ts";
import * as helper from "https://deno.land/x/denops_std@v4.0.0/helper/mod.ts";
import * as vars from "https://deno.land/x/denops_std@v4.0.0/variable/mod.ts";
import * as fn from "https://deno.land/x/denops_std@v4.0.0/function/mod.ts";
import outdent from "https://deno.land/x/outdent@v0.8.0/mod.ts";

interface Command {
  run: (denops: Denops, controller: AbortController) => Promise<void>;
}

class CmdHeyEdit implements Command {
  constructor(
    public readonly firstline: number,
    public readonly lastline: number,
    public readonly request: string
  ) {}
  public static readonly cmd: "heyEdit" = "heyEdit";
  public async run(denops: Denops, controller: AbortController) {
    const indent = " ".repeat(
      (await fn.indent(denops, this.firstline)) as number
    );
    const precontext = (
      await fn.getline(
        denops,
        Math.max(this.firstline - 20, 0),
        this.firstline - 1
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

    const model = await getModel(denops, indent);
    await model.call(
      [new SystemChatMessage(systemPrompt), new HumanChatMessage(userPrompt)],
      {
        options: { signal: controller.signal },
      }
    );
  }
}

class CmdHey implements Command {
  constructor(
    public readonly firstline: number,
    public readonly lastline: number
  ) {}
  public static readonly cmd: "heyEdit" = "heyEdit";
  public async run(denops: Denops, controller: AbortController) {
    const indent = " ".repeat(
      (await fn.indent(denops, this.firstline)) as number
    );
    const context = (
      await fn.getline(denops, this.firstline, this.lastline)
    ).join("\n");
    await fn.deletebufline(denops, "%", this.firstline + 1, this.lastline);
    await fn.setline(denops, this.lastline + 1, [indent]);
    await fn.setcursorcharpos(denops, this.lastline + 1, 0);

    // const systemPrompt = '';
    const userPrompt = context;
    const model = await getModel(denops, indent);
    await model.call([new HumanChatMessage(userPrompt)], {
      options: { signal: controller.signal },
    });
  }
}

async function getModel(denops: Denops, indent: string): Promise<ChatOpenAI> {
  const mutex = new Mutex();
  return new ChatOpenAI({
    modelName: await vars.g.get(denops, "hey_model_name", "gpt-3.5-turbo"),
    verbose: await vars.g.get(denops, "hey_verbose", false),
    streaming: true,
    callbacks: [
      {
        async handleLLMNewToken(token: string) {
          await mutex.runExclusive(async () => {
            const crow = await fn.line(denops, ".");
            const cline = await fn.getline(denops, crow);
            const lines = (cline + token)
              .replace("\n", "\n" + indent)
              .split("\n");
            const nrow = crow + lines.length - 1;
            const ncol = Array.from(
              new Intl.Segmenter().segment(lines.at(-1)!)
            ).length;
            await fn.append(denops, crow, Array(lines.length - 1).fill(""));
            await fn.setline(denops, crow, lines);
            await fn.setcursorcharpos(denops, nrow, ncol);
          });
        },
      },
    ],
  });
}

export async function main(denops: Denops) {
  let controller: AbortController | undefined;
  const seq_curs: number[] = [];
  let cmd: Command | undefined = undefined;

  const createCmd = <T extends new (...args: any[]) => Command>(cls: T) => {
    return async (...args: unknown[]) => {
      const { seq_cur } = (await fn.undotree(denops)) as { seq_cur: number };
      seq_curs.push(seq_cur);
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
    // async heyEdit(...args) {
    //   const { seq_cur } = (await fn.undotree(denops)) as { seq_cur: number };
    //   seq_curs.push(seq_cur);
    //   cmd = new CmdHeyEdit(
    //     ...(args as ConstructorParameters<typeof CmdHeyEdit>)
    //   );
    //   try {
    //     controller = new AbortController();
    //     await cmd.run(denops, controller);
    //   } catch (e) {
    //     console.log(e);
    //   } finally {
    //     controller = undefined;
    //   }
    // },
    async undo() {
      await denops.cmd(`undo ${seq_curs.pop()}`);
    },
    async again() {
      if (!cmd) {
        return;
      }
      const { seq_cur } = (await fn.undotree(denops)) as { seq_cur: number };
      seq_curs.push(seq_cur);
      await denops.cmd(`undo ${seq_curs.at(-2)}`);
      try {
        controller = new AbortController();
        await cmd.run(denops, controller);
      } catch (e) {
        console.log(e);
      } finally {
        controller = undefined;
      }
    },
    abort: () => Promise.resolve(() => controller?.abort()),
  };
  const script = outdent`
    function! HeyEdit(prompt) range abort
      call denops#notify("${denops.name}", "heyEdit", [a:firstline, a:lastline, a:prompt])
    endfunction
    command! -nargs=1 -range HeyEdit <line1>,<line2>call HeyEdit(<q-args>)

    function! Hey() range abort
      call denops#notify("${denops.name}", "hey", [a:firstline, a:lastline])
    endfunction
    command! -range Hey <line1>,<line2>call Hey()

    function! HeyAbort() abort
      call denops#notify("${denops.name}", "abort", [])
    endfunction
    command! HeyAbort call HeyAbort()
    map <Plug>HeyAbort <Cmd>HeyAbort<CR>

    function! HeyUndo() abort
      call denops#notify("${denops.name}", "undo", [])
    endfunction
    command! HeyUndo call HeyUndo()
    map <Plug>HeyUndo <Cmd>HeyUndo<CR>

    function! HeyAgain() abort
      call denops#notify("${denops.name}", "again", [])
    endfunction
    command! HeyAgain call HeyAgain()
    map <Plug>HeyAgain <Cmd>HeyAgain<CR>
  `;

  await helper.execute(denops, script);
}

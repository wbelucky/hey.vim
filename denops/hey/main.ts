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

/**
 * The `hey` function sends a message to the ChatOpenAI model registered with Denops.
 *
 * @param {Denops} denops - The Denops object for current buffer
 * @param {number} firstline - The first line number of the range to send
 * @param {number} lastline - The last line number of the range to send
 * @param {string} request - The input text to send to the model
 * @param {AbortController} controller - The AbortController to abort the request
 * @returns {Promise<void>}
 */
async function hey(
  denops: Denops,
  firstline: number,
  lastline: number,
  request: string,
  controller: AbortController
): Promise<void> {
  const precontext = (
    await fn.getline(denops, Math.max(firstline - 20, 0), firstline - 1)
  ).join("\n");
  const postcontext = (
    await fn.getline(denops, lastline + 1, lastline + 20)
  ).join("\n");
  const context = (await fn.getline(denops, firstline, lastline)).join("\n");
  const indent = " ".repeat((await fn.indent(denops, firstline)) as number);
  const mutex = new Mutex();
  await fn.deletebufline(denops, "%", firstline + 1, lastline);
  await fn.setline(denops, firstline, [indent]);
  await fn.setcursorcharpos(denops, firstline, 0);

  const model = new ChatOpenAI({
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
    <Prompt>${request}</Prompt>
    <PreContext>${outdent.string("\n" + precontext)}</PreContext>
    <Target>${outdent.string("\n" + context)}</Target>
    <PostContext>${outdent.string("\n" + postcontext)}</PostContext>
  `;

  const userPrompt = outdent`
    <Prompt>${request}</Prompt>
    <PreContext>${outdent.string("\n" + precontext)}</PreContext>
    <Target>${outdent.string("\n" + context)}</Target>
    <PostContext>${outdent.string("\n" + postcontext)}</PostContext>
  `;

  await model.call(
    [new SystemChatMessage(systemPrompt), new HumanChatMessage(userPrompt)],
    { options: { signal: controller.signal } }
  );
}

export async function main(denops: Denops) {
  let controller: AbortController | undefined;
  const seq_curs: number[] = [];
  let myfirstline = 0;
  let mylastline = 0;
  let myprompt = "";

  denops.dispatcher = {
    async hey(...args) {
      const afistline = args[0] as number;
      const alastline = args[1] as number;
      const aprompt = args[2] as string;
      const { seq_cur } = (await fn.undotree(denops)) as { seq_cur: number };
      seq_curs.push(seq_cur);
      myfirstline = afistline;
      mylastline = alastline;
      myprompt = aprompt;
      try {
        controller = new AbortController();
        await hey(denops, myfirstline, mylastline, myprompt, controller);
      } catch (e) {
        console.log(e);
      } finally {
        controller = undefined;
      }
    },
    async undo() {
      await denops.cmd(`undo ${seq_curs.pop()}`);
    },
    async again() {
      const { seq_cur } = (await fn.undotree(denops)) as { seq_cur: number };
      seq_curs.push(seq_cur);
      await denops.cmd(`undo ${seq_curs.at(-2)}`);
      try {
        controller = new AbortController();
        await hey(denops, myfirstline, mylastline, myprompt, controller);
      } catch (e) {
        console.log(e);
      } finally {
        controller = undefined;
      }
    },
    abort: () =>
      new Promise((res) => {
        controller?.abort();
        res(null);
      }),
  };
  await helper.execute(
    denops,
    outdent`
    function! Hey(prompt) range abort
      call denops#notify("${denops.name}", "hey", [a:firstline, a:lastline, a:prompt])
    endfunction
    command! -nargs=1 -range Hey <line1>,<line2>call Hey(<q-args>)

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
  `
  );
}

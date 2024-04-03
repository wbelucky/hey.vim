function! hey#edit(prompt) range abort
  call denops#notify("hey", "heyEdit", [a:firstline, a:lastline, a:prompt])
endfunction

function! hey#hey() range abort
  call denops#notify("hey", "hey", [a:firstline, a:lastline])
endfunction

function! hey#abort() abort
  call denops#notify("hey", "abort", [])
endfunction

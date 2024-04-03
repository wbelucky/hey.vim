command! -nargs=1 -range HeyEdit <line1>,<line2>call hey#edit(<q-args>)

command! -range Hey <line1>,<line2>call hey#hey()

command! HeyAbort call hey#abort()
map <Plug>HeyAbort <Cmd>HeyAbort<CR>

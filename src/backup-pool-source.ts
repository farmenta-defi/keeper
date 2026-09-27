1 | console.log(await Bun.file(process.argv[2]).text())
                          ^
TypeError: Expected file path string or file descriptor
 code: "ERR_INVALID_ARG_TYPE"

      at /Users/iballibull/Documents/Project/Farmenta/keeper/[eval]:1:23

Bun v1.3.14 (macOS arm64)

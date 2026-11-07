# Public Source BSP test maps

| file | bytes | SHA-256 | origin |
| --- | ---: | --- | --- |
| `test2.bsp` | 213,776 | `2922035b7d7a9bbea62d1a45545186a68b06c6092d0e1e8bf9bbe83d328b1187` | bsp_tool `tests/maps/Team Fortress 2/test2.bsp` |
| `test_physcollide.bsp` | 34,308 | `a40d51e77bb8adb09ba337f5685d1f64f18d8a1e77dc717b0e131ecda1b3b539` | bsp_tool `tests/maps/Team Fortress 2/test_physcollide.bsp` |
| `mp_lobby.bsp` | 46,528 | `5baa19716fc06c66a814afe9d87d3fd8ec684d6b457c43afbeb3d74d223995a1` | bsp_tool `tests/maps/Team Fortress 2/mp_lobby.bsp` |

From github.com/snake-biscuits/bsp_tool at commit `655627ea8704353ac14bd753df8ca05c15838eda` (2026-09-23). Its
`sources.txt` lists them as "handmade [by @snake-biscuits]". The repository is GPL-3.0. They are kept here as test data
in this private repository and are not part of any build. The `*.bsp.info.txt` files there are Valve's `vbspinfo`
output for each map, and `tests/bsp.test.ts` checks the readers' counts against them.

`lzma-sample.bin` is `lzma-sample.txt` compressed by liblzma (Python `lzma`, LZMA1, 64 KiB dictionary), with Valve's
17-byte `LZMA` lump header.

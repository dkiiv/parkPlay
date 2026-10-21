# Third-party notices

ParkPlay's own code is under the MIT License (see `LICENSE`). This file lists the third-party work
that this repository **contains** (section 1) and the third-party software and services it
**uses but does not contain** (section 2). Section 3 has the full license texts that section 1
requires.

## 1. Included in this repository

### JSMpeg

- File: `web/vendor/jsmpeg.min.js` (unmodified copy of the upstream `jsmpeg.min.js`,
  SHA-256 `c0286ac82193fc9c9d5490ade425db04c446d9115bfe6823bf9bc0b0703c7760`)
- Upstream: <https://github.com/phoboslab/jsmpeg>
- Copyright (c) 2017 Dominic Szablewski
- License: MIT (full text in section 3.1)
- Used by: `web/signin.html` (sign-in sign-in view) and `web/probe.html`

### Material Icons (SVG path data)

- Upstream: <https://github.com/google/material-design-icons> (<https://fonts.google.com/icons>)
- Copyright Google LLC
- License: Apache License 2.0 (full text in section 3.2)
- Changes: the path data was rewritten in shorter form (coordinates rounded to one decimal,
  arcs instead of curves, commands reordered), and placed in inline `<symbol>` elements. The
  `i-rew`/`i-fwd` icons combine the `replay` arrow (mirrored for forward) with a "10" text label.

| File | Symbol id | Material icon |
|---|---|---|
| `web/index.html` | `i-home` | `home` |
| `web/index.html` | `i-subs` | `subscriptions` |
| `web/index.html` | `i-hist` | `history` |
| `web/index.html` | `i-later` | `watch_later` |
| `web/index.html` | `i-search` | `search` |
| `web/index.html` | `i-user` | `person` |
| `web/index.html` | `i-play` | `play_arrow` |
| `web/index.html` | `i-pause` | `pause` |
| `web/index.html` | `i-rew` | `replay` (+ "10" label) |
| `web/index.html` | `i-fwd` | `replay`, mirrored (+ "10" label) |
| `web/index.html` | `i-full` | `fullscreen` |
| `web/index.html` | `i-refresh` | `refresh` |
| `web/index.html` | `i-vol` | `volume_up` |
| `web/index.html` | `i-back` | chevron; close to `arrow_back_ios_new` |
| `web/signin.html` | `i-back`, `i-fwd` | chevron; close to `arrow_back_ios_new` / `arrow_forward_ios` |
| `web/signin.html` | `i-reload` | `refresh` |
| `web/signin.html` | `i-home` | `home` |
| `web/signin.html` | `i-kbd` | `keyboard` |
| `web/signin.html` | `i-full` | `fullscreen` |
| `web/signin.html` | `i-menu` | `menu` |
| `web/signin.html` | `i-bksp` | `backspace` |
| `web/signin.html` | `i-enter` | `keyboard_return` |
| `web/signin.html` | `i-close` | `close` |
| `web/signin.html` | `i-play` | `play_arrow` |

The back/forward chevrons are simple shapes that don't match any Material path exactly; they are
listed here to be safe. `web/favicon.svg` and the rail logo in `web/index.html` are original
drawings for this project, not Material icons.

## 2. Used, not included

None of the following is contained in this repository. Each is installed separately (by the
operator, by `npm install`, or by `deploy/lxc/install.sh` at install time) under its own license,
and is not redistributed by this project.

### npm dependencies (installed by `npm install` in `server/`)

| Package | License | Copyright |
|---|---|---|
| [ws](https://github.com/websockets/ws) (`^8.18.0`) | MIT | (c) 2011 Einar Otto Stangvik, (c) 2013 Arnout Kazemier and contributors, (c) 2016 Luigi Pinca and contributors |

`ws` has no runtime dependencies of its own.

### Programs run by the server or installer

| Software | License | How it is obtained | Role |
|---|---|---|---|
| [Node.js](https://nodejs.org/) (>= 20) | MIT (plus bundled third-party licenses) | OS package (`install.sh`) | runs the server |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | The Unlicense (public domain dedication) | installed by the operator (not done by `install.sh`) | feeds, search, stream-URL resolution (v2) |
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1+ or GPL-2.0+, depending on build (distro builds include GPL parts such as libx264) | OS package | v1 screen/audio encoder; generates the `/probe` test clips at install time |
| [Google Chrome](https://www.google.com/chrome/) | proprietary, Google Chrome Terms of Service | Google's apt repository, added by `install.sh` | v1 kiosk browser used for the one-time sign-in |
| [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) | GPL-3.0 | latest release zip downloaded from GitHub by `install.sh` into `/var/lib/parkplay/extensions/` | optional ad blocking in the kiosk; not bundled or modified |
| [Caddy](https://caddyserver.com/) | Apache-2.0 | OS package | TLS + reverse proxy for the stream hostname |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0 | release binary downloaded from GitHub by `install.sh` | Cloudflare Tunnel for the UI hostname |
| Xvfb (X.Org) | MIT/X11 | OS package | v1 virtual screen |
| [PulseAudio](https://www.freedesktop.org/wiki/Software/PulseAudio/) | LGPL-2.1+ | OS package | v1 audio sink |
| [WireGuard tools](https://www.wireguard.com/) | GPL-2.0 | OS package (operator) | optional VPS tunnel (`deploy/vps`, `deploy/lxc/wg-*`) |
| [nftables](https://netfilter.org/projects/nftables/) | GPL-2.0 | OS package (operator) | optional VPS port forward |
| Noto fonts, Liberation fonts | SIL Open Font License 1.1 | OS packages | fonts in the kiosk browser |
| jq, curl, unzip, gnupg | MIT / curl license / Info-ZIP / GPL-3.0 | OS packages | used by `install.sh` |

The test tools in `tools/` additionally start the locally installed Chrome in headless mode.

### Online services

ParkPlay talks to YouTube/Google (video data, thumbnails from `i.ytimg.com`, media from
`googlevideo.com`, Google sign-in) and to Cloudflare (Tunnel and Access). Use of those services
is governed by their own terms; see the "Legal" section of the README.

## 3. License texts

### 3.1 MIT License (JSMpeg)

```text
The MIT License (MIT)
Copyright (c) 2017 Dominic Szablewski

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### 3.2 Apache License 2.0 (Material Icons)

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

# Step 001 — Build system & repo layout

Goal: stand up the C++/CMake skeleton (`shared/` + `server/` + `client/`) that
consumes `../amis-engine` and fetches ENet, without deleting the existing TS
tree yet. End state: an empty-but-linking client window + a headless server that
starts an ENet host and accepts a connection.

Prereqs: read `000_overview.md`. Reference files: `tower-d/CMakeLists.txt`,
`tower-d/project.conf`, `tower-d/{client,server,shared}/CMakeLists.txt`,
`tower-d/Makefile`, `../amis-engine/project-boilerplate/`.

---

## 1. Target tree

```
space-simulator-mmo/
├── CMakeLists.txt            # root: engine detection + add_subdirectory
├── project.conf             # single source of truth (name/version/ids)
├── Makefile                 # convenience targets (configure/build/run)
├── shared/
│   ├── CMakeLists.txt
│   ├── include/shared/       # math.h, game_config.h, sim_types.h, net_shared.h
│   └── src/                  # net_shared.cpp
├── server/
│   ├── CMakeLists.txt        # fetch ENet, link amis + shared
│   └── src/
│       ├── main.cpp
│       ├── game_server/      # ENet thread
│       └── sim/              # ported simulation
├── client/
│   ├── CMakeLists.txt        # fetch ENet, link amis + shared
│   ├── src/
│   │   ├── main.cpp
│   │   ├── server/           # ENet peer wrapper (client side)
│   │   ├── scenes/
│   │   └── render/
│   ├── assets/
│   └── platform/             # macOS/iOS/linux/windows (copy from tower-d)
├── apps/ packages/          # OLD TS — kept until step 012, ignored by CMake
└── docs/
```

Keep `apps/` and `packages/` in place. CMake never globs them; the TS build
(`pnpm`) and C++ build (`cmake`) coexist during the transition.

## 2. `project.conf`

Copy tower-d's format (parsed by root `CMakeLists.txt`):

```ini
APP_NAME=Space Simulator
APP_VERSION=0.1.0
BUNDLE_ID=com.jp.spacesim
CLIENT_TARGET=spacesim
SERVER_TARGET=spacesim-server
```

## 3. Root `CMakeLists.txt`

Mirror tower-d's engine detection (SDK → vendor → env → relative). Minimal form:

```cmake
cmake_minimum_required(VERSION 3.24)
project(space_simulator CXX C)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# --- locate amis-engine (see tower-d/CMakeLists.txt:91-256 for the full ladder)
function(resolve_amis_engine)
  foreach(cand
      "$ENV{AMIS_ENGINE_PATH}" "${AMIS_ENGINE_PATH}"
      "${CMAKE_SOURCE_DIR}/vendor/amis-engine"
      "${CMAKE_SOURCE_DIR}/../amis-engine")
    if(cand AND EXISTS "${cand}/CMakeLists.txt")
      set(AMIS_ENGINE_DIR "${cand}" PARENT_SCOPE)
      return()
    endif()
  endforeach()
  message(FATAL_ERROR "amis-engine not found; set AMIS_ENGINE_PATH")
endfunction()
resolve_amis_engine()
message(STATUS "amis-engine: ${AMIS_ENGINE_DIR}")
add_subdirectory("${AMIS_ENGINE_DIR}" "${CMAKE_BINARY_DIR}/amis-engine")

# --- read project.conf into CMake vars (see tower-d root CMakeLists for parser)
# ... parse APP_NAME/BUNDLE_ID/... into cache vars, expose as compile defs ...

add_subdirectory(shared)
add_subdirectory(server)
add_subdirectory(client)
```

> Copy tower-d's `project.conf` parser verbatim — it's ~30 lines of
> `file(STRINGS ...)` + `string(REGEX ...)`. Don't reinvent it.

## 4. ENet via FetchContent

Both `server/CMakeLists.txt` and `client/CMakeLists.txt` need ENet. Put it in a
helper included by both (or fetch once at root). tower-d fetches per-app; simplest
is a root-level fetch so the target is defined once:

```cmake
include(FetchContent)
FetchContent_Declare(enet
  GIT_REPOSITORY https://github.com/lsalzman/enet.git
  GIT_TAG        v1.3.18)
FetchContent_MakeAvailable(enet)
# target: `enet` (static). Include dir: ${enet_SOURCE_DIR}/include
```

## 5. `shared/CMakeLists.txt`

```cmake
add_library(shared STATIC
  src/net_shared.cpp)
target_include_directories(shared PUBLIC include)
target_link_libraries(shared PUBLIC amis)   # for amis::MemArena in streams
```

`shared` links `amis` because `OutputStream` allocates from an `amis::MemArena`
(see step 003). It does **not** link ENet — protocol is transport-agnostic.

## 6. `server/CMakeLists.txt`

```cmake
file(GLOB_RECURSE SERVER_SRC CONFIGURE_DEPENDS src/*.cpp)
add_executable(${SERVER_TARGET} ${SERVER_SRC})
target_link_libraries(${SERVER_TARGET} PRIVATE amis shared enet)
target_compile_definitions(${SERVER_TARGET} PRIVATE
  AMIS_APP_NAME="${APP_NAME} Server" AMIS_HEADLESS=1)
```

## 7. `client/CMakeLists.txt`

Copy tower-d's client CMake (it wires platform dirs, asset packaging via the amis
asset-packer, and the `amis` link). Key bits:

```cmake
file(GLOB_RECURSE CLIENT_SRC CONFIGURE_DEPENDS src/*.cpp)
add_executable(${CLIENT_TARGET} ${CLIENT_SRC})
target_link_libraries(${CLIENT_TARGET} PRIVATE amis shared enet)
target_compile_definitions(${CLIENT_TARGET} PRIVATE
  AMIS_APP_NAME="${APP_NAME}" AMIS_BUNDLE_ID="${BUNDLE_ID}")
# asset packaging: invoke amis asset-packer on client/assets → *.amispkg
# (copy the custom command from tower-d/client/CMakeLists.txt)
```

Copy `tower-d/client/platform/` wholesale (macOS entitlements, iOS plist, etc.)
and rename bundle ids to match `project.conf`.

## 8. `Makefile` (convenience)

```make
BUILD ?= build
configure:
	cmake -S . -B $(BUILD) -DCMAKE_BUILD_TYPE=Debug
build: configure
	cmake --build $(BUILD) -j
server: build
	$(BUILD)/bin/spacesim-server
client: build
	$(BUILD)/bin/spacesim
clean:
	rm -rf $(BUILD)
```

## 9. mise tasks

Extend the existing `.mise.toml` so old and new stacks coexist:

```toml
[tasks.cpp-build]   run = "make build"
[tasks.cpp-server]  run = "make server"
[tasks.cpp-client]  run = "make client"
# existing pnpm dev/test tasks stay untouched
```

## 10. `.gitignore` / `.rsyncignore`

Add `build/`, `vendor/amis-sdk/`, `*.amispkg`.

## 11. Smoke test (definition of done)

1. `main.cpp` for both server and client that only calls `amis::app_run` with a
   `start` that logs and (server) initializes ENet, (client) opens a window with
   a clear color. Stub bodies — real content in steps 004/008.
2. `make build` compiles all three targets against the real engine.
3. `make server` prints "ENet host listening on :9002".
4. `make client` opens a window filled with `color_hex(0x1A1A2E)`.

## 12. Unresolved questions

- Fetch ENet once at root vs per-app? Default root (single `enet` target).
- Pin ENet to v1.3.18 tag or track a fork with CMake niceties? Default upstream tag.
- Reuse tower-d asset-packer custom command as-is? Confirm amis tool path/flags.
- Windows/iOS platform dirs needed for v1, or macOS+Linux only first? Default desktop-first.

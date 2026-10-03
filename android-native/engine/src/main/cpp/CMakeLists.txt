# libboar_engine.so: llama.cpp (pinned submodule) + BOAR's JNI. CPU only; the best CPU variant
# (armv8.0 … armv9.2 with dotprod, i8mm, sve2, sme) is chosen at run time by ggml's backend loader.
cmake_minimum_required(VERSION 3.22)
project(boar_engine C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP ON CACHE BOOL "" FORCE)
set(GGML_CPU_KLEIDIAI ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)

set(LLAMA_SRC ${CMAKE_CURRENT_LIST_DIR}/llama.cpp)
add_subdirectory(${LLAMA_SRC} build-llama)

# SQLite with FTS5 (same feature flags as expo-sqlite) and zstd decompression, compiled in.
add_library(boar_sqlite STATIC sqlite/sqlite3.c)
target_compile_definitions(boar_sqlite PRIVATE
    SQLITE_ENABLE_FTS5 SQLITE_ENABLE_FTS4 SQLITE_ENABLE_FTS3_PARENTHESIS SQLITE_ENABLE_MATH_FUNCTIONS
    SQLITE_THREADSAFE=1 SQLITE_DEFAULT_MEMSTATUS=0 SQLITE_DQS=0 SQLITE_OMIT_DEPRECATED SQLITE_MAX_EXPR_DEPTH=0)
target_compile_options(boar_sqlite PRIVATE -O2 -w)
set_target_properties(boar_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)

set(ZSTD_LIB ${CMAKE_CURRENT_LIST_DIR}/zstd/lib)
file(GLOB ZSTD_SRC ${ZSTD_LIB}/common/*.c ${ZSTD_LIB}/decompress/*.c)
add_library(boar_zstd STATIC ${ZSTD_SRC})
target_include_directories(boar_zstd PUBLIC ${ZSTD_LIB} ${ZSTD_LIB}/common)
target_compile_definitions(boar_zstd PRIVATE ZSTD_DISABLE_ASM ZSTD_MULTITHREAD=0)
target_compile_options(boar_zstd PRIVATE -O2 -w)
set_target_properties(boar_zstd PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(boar_engine SHARED boar_jni.cpp boar_sqlite.cpp)
target_include_directories(boar_engine PRIVATE
    ${LLAMA_SRC}/include ${LLAMA_SRC}/common ${LLAMA_SRC}/ggml/include ${LLAMA_SRC}/vendor
    ${CMAKE_CURRENT_LIST_DIR}/sqlite ${ZSTD_LIB})
target_link_libraries(boar_engine llama llama-common ggml boar_sqlite boar_zstd android log)

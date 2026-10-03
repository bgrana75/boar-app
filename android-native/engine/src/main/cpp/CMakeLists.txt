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

add_library(boar_engine SHARED boar_jni.cpp)
target_include_directories(boar_engine PRIVATE
    ${LLAMA_SRC}/include ${LLAMA_SRC}/common ${LLAMA_SRC}/ggml/include ${LLAMA_SRC}/vendor)
target_link_libraries(boar_engine llama llama-common ggml android log)

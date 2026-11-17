#pragma once
struct PerfApi {
 void* (*create)(double,int,const char*,const char*,const char*);
 void (*process)(void*,float*,float*,int);
 void (*destroy)(void*);
};
extern "C" PerfApi sy1_before_api();
extern "C" PerfApi sy1_after_api();

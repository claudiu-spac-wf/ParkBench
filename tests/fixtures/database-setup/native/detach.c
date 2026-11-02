/* Public native acceptance fixture, never packaged in the production DB image. */
#define _POSIX_C_SOURCE 200809L
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <limits.h>
static int marker(const char *name,const char *text){int fd=open(name,O_WRONLY|O_CREAT|O_TRUNC,0644);if(fd<0)return 1;size_t length=0;while(text[length])length++;int result=write(fd,text,length)==(ssize_t)length?0:1;close(fd);return result;}
int main(int argc,char **argv){
 if(argc!=2)return 2;
 pid_t child=fork();if(child<0)return 3;if(child>0)return 0;
 if(setsid()<0)_exit(4);
 child=fork();if(child<0)_exit(5);if(child>0)_exit(0);
 close(0);close(1);close(2);
 char started[PATH_MAX],release[PATH_MAX];
 if(snprintf(started,sizeof(started),"%s/child-started",argv[1])>=(int)sizeof(started)||snprintf(release,sizeof(release),"%s/child-release",argv[1])>=(int)sizeof(release))_exit(6);
 if(marker(started,"started\n"))_exit(7);
 while(access(release,F_OK)){struct timespec delay={0,20000000};nanosleep(&delay,NULL);}
 _exit(marker("native-child-result","modified\n"));
}

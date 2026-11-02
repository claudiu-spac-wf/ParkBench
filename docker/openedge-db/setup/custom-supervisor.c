#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <limits.h>

static volatile sig_atomic_t cancelled=0;
static const char *record;
static void stop(int sig){(void)sig;cancelled=1;}
static int write_record(const char *suffix,const char *value){
 char file[PATH_MAX],temporary[PATH_MAX];
 if(snprintf(file,sizeof(file),"%s.%s",record,suffix)>=(int)sizeof(file))return -1;
 if(snprintf(temporary,sizeof(temporary),"%s.%ld.tmp",file,(long)getpid())>=(int)sizeof(temporary))return -1;
 int fd=open(temporary,O_WRONLY|O_CREAT|O_TRUNC,0644);if(fd<0)return -1;
 size_t length=strlen(value),offset=0;while(offset<length){ssize_t n=write(fd,value+offset,length-offset);if(n<0&&errno==EINTR)continue;if(n<=0){close(fd);unlink(temporary);return -1;}offset+=(size_t)n;}
 int failed=fsync(fd);if(close(fd)<0)failed=-1;if(failed<0||rename(temporary,file)<0){unlink(temporary);return -1;}return 0;
}
static int write_exit(const char *suffix,int value){char text[20];snprintf(text,sizeof(text),"%d\n",value);return write_record(suffix,text);}
static int read_exit(const char *suffix,int *value){char file[PATH_MAX],extra;int n=-1;if(snprintf(file,sizeof(file),"%s.%s",record,suffix)>=(int)sizeof(file))return -1;FILE *f=fopen(file,"r");if(!f)return -1;int count=fscanf(f,"%d %c",&n,&extra);fclose(f);if(count!=1||n<0||n>255)return -1;*value=n;return 0;}
static int observed(void){char file[PATH_MAX];if(snprintf(file,sizeof(file),"%s.primary-observed",record)>=(int)sizeof(file))return 0;return access(file,R_OK)==0;}
static int exit_status(int status){return WIFEXITED(status)?WEXITSTATUS(status):WIFSIGNALED(status)?128+WTERMSIG(status):255;}
static double monotonic(void){struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return 0;return (double)t.tv_sec+(double)t.tv_nsec/1e9;}
/* pidfds stabilize signals. /proc assists cancellation only; waitpid ECHILD proves completion. */
static int signal_tree(pid_t parent,int sig,unsigned depth){
 if(depth>128)return 0;
 char filename[128];snprintf(filename,sizeof(filename),"/proc/%ld/task/%ld/children",(long)parent,(long)parent);
 FILE *f=fopen(filename,"r");if(!f)return errno==ENOENT?0:-1;
 long child;int result=0;
 while(fscanf(f,"%ld",&child)==1){
  int fd=(int)syscall(SYS_pidfd_open,(pid_t)child,0);
  if(fd<0){if(errno!=ESRCH)result=-1;continue;}
  if(signal_tree((pid_t)child,sig,depth+1)<0)result=-1;
  if(syscall(SYS_pidfd_send_signal,fd,sig,NULL,0)<0&&errno!=ESRCH)result=-1;
  close(fd);
 }
 fclose(f);return result;
}
static int capability(void){int value=0;if(prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)||prctl(PR_GET_CHILD_SUBREAPER,&value,0,0,0)||value!=1)return -1;int fd=(int)syscall(SYS_pidfd_open,getpid(),0);if(fd<0)return -1;close(fd);return 0;}
int main(int argc,char **argv){
 if(argc==2&&!strcmp(argv[1],"--check"))return capability()?75:0;
 if(argc!=3||capability())return 75;
 record=argv[2];
 if(write_record("process","ACTIVE\n"))return 70;
 if(setenv("PARKBENCH_PRIMARY_RECORD",record,1))return 70;
 struct sigaction action;memset(&action,0,sizeof(action));action.sa_handler=stop;sigemptyset(&action.sa_mask);
 if(sigaction(SIGTERM,&action,NULL)||sigaction(SIGINT,&action,NULL))return 75;
 pid_t shell=fork();if(shell<0){write_record("process","UNCONFIRMED\n");return 75;}
 if(shell==0){signal(SIGTERM,SIG_DFL);signal(SIGINT,SIG_DFL);setpgid(0,0);execl("/bin/sh","sh",argv[1],(char*)NULL);_exit(127);}
 (void)setpgid(shell,shell);
 int shell_seen=0,shell_exit=0,uncertain=0;double cancel_at=0;
 for(;;){
  int status;pid_t child=waitpid(-1,&status,WNOHANG);
  if(child>0){if(child==shell){shell_seen=1;shell_exit=exit_status(status);if(write_exit("shell-exit",shell_exit))uncertain=1;}continue;}
  if(child<0){if(errno==EINTR)continue;if(errno==ECHILD)break;uncertain=1;break;}
  int primary_known=0,primary_value=0;
  primary_known=read_exit("primary-exit",&primary_value)==0;
  if(cancelled||(primary_known&&primary_value!=0)||(shell_seen&&shell_exit!=0)){if(cancel_at==0)cancel_at=monotonic();int sig=monotonic()-cancel_at>=5?SIGKILL:SIGTERM;if(signal_tree(getpid(),sig,0)<0)uncertain=1;}
  struct timespec delay={0,20000000};nanosleep(&delay,NULL);
 }
 if(!shell_seen||uncertain){write_record("process","UNCONFIRMED\n");return 75;}
 struct timespec now;struct tm utc;char stamp[40];if(clock_gettime(CLOCK_REALTIME,&now)||!gmtime_r(&now.tv_sec,&utc)||!strftime(stamp,sizeof(stamp),"%Y-%m-%dT%H:%M:%SZ\n",&utc)){write_record("process","UNCONFIRMED\n");return 75;}
 if(write_record("quiescent-at",stamp)||write_record("process","QUIESCENT\n"))return 70;
 int primary_exit=0;
 if(cancelled)return 72;
 int primary_known=observed()&&read_exit("primary-exit",&primary_exit)==0;
 if(primary_known&&primary_exit)return primary_exit;
 if(shell_exit)return shell_exit;
 return primary_known?0:70;
}

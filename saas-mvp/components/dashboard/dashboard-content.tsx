"use client";

import Link from "next/link";
import { FolderKanban, CheckCircle2, Users, TrendingUp, Clock, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PRIORITY_COLORS, PRIORITY_LABELS, TASK_STATUS_LABELS, getInitials } from "@/lib/utils";
import type { Organization, Project, Task, User, Priority } from "@prisma/client";
import type { User as AuthUser } from "next-auth";

interface DashboardContentProps {
  user: AuthUser;
  org: Organization;
  projects: (Project & { _count: { tasks: number } })[];
  myTasks: (Task & {
    project: { id: string; name: string; color: string };
    assignee: { id: string; name: string | null; image: string | null } | null;
  })[];
  stats: {
    completedTasks: number;
    activeTasks: number;
    memberCount: number;
    projectCount: number;
  };
}

export function DashboardContent({ user, org, projects, myTasks, stats }: DashboardContentProps) {
  const greeting = getGreeting();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {greeting}, {user.name?.split(" ")[0]} 👋
        </h1>
        <p className="text-gray-500 mt-0.5">
          Here&apos;s what&apos;s happening in {org.name} today.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Active Tasks", value: stats.activeTasks, icon: Clock, color: "text-blue-600", bg: "bg-blue-50" },
          { label: "Completed", value: stats.completedTasks, icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50" },
          { label: "Projects", value: stats.projectCount, icon: FolderKanban, color: "text-indigo-600", bg: "bg-indigo-50" },
          { label: "Team Members", value: stats.memberCount, icon: Users, color: "text-purple-600", bg: "bg-purple-50" },
        ].map((stat) => (
          <Card key={stat.label} className="border-gray-100 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
                  <p className="text-sm text-gray-500 mt-0.5">{stat.label}</p>
                </div>
                <div className={`h-10 w-10 rounded-xl ${stat.bg} flex items-center justify-center`}>
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* My Tasks */}
        <div className="lg:col-span-2">
          <Card className="border-gray-100 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base font-semibold text-gray-900">My Tasks</CardTitle>
              <Link href="/dashboard/projects">
                <Button variant="ghost" size="sm" className="text-indigo-600 hover:text-indigo-700 h-8 px-3 text-xs">
                  View all
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="pt-0">
              {myTasks.length === 0 ? (
                <div className="py-8 text-center">
                  <CheckCircle2 className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">No tasks assigned to you</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {myTasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-indigo-100 hover:bg-indigo-50/30 transition-all cursor-pointer"
                    >
                      <div className="mt-0.5 shrink-0">
                        {task.status === "IN_PROGRESS" ? (
                          <div className="h-4 w-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                        ) : (
                          <div className="h-4 w-4 rounded-full border-2 border-gray-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{task.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className="inline-flex items-center gap-1 text-xs"
                            style={{ color: task.project.color }}
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: task.project.color }} />
                            {task.project.name}
                          </span>
                          <span className="text-gray-300">·</span>
                          <span className={`text-xs font-medium ${PRIORITY_COLORS[task.priority as Priority]}`}>
                            {PRIORITY_LABELS[task.priority as Priority]}
                          </span>
                          {task.dueDate && (
                            <>
                              <span className="text-gray-300">·</span>
                              <span className={`flex items-center gap-1 text-xs ${new Date(task.dueDate) < new Date() ? "text-red-500" : "text-gray-500"}`}>
                                {new Date(task.dueDate) < new Date() && <AlertCircle className="h-3 w-3" />}
                                {formatDistanceToNow(new Date(task.dueDate), { addSuffix: true })}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {TASK_STATUS_LABELS[task.status as keyof typeof TASK_STATUS_LABELS]}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Projects */}
        <div>
          <Card className="border-gray-100 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base font-semibold text-gray-900">Projects</CardTitle>
              <Link href="/dashboard/projects">
                <Button variant="ghost" size="sm" className="text-indigo-600 hover:text-indigo-700 h-8 px-3 text-xs">
                  View all
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="pt-0">
              {projects.length === 0 ? (
                <div className="py-8 text-center">
                  <FolderKanban className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500 mb-3">No projects yet</p>
                  <Link href="/dashboard/projects/new">
                    <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700">
                      Create project
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  {projects.map((project) => (
                    <Link
                      key={project.id}
                      href={`/dashboard/projects/${project.id}`}
                      className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:border-indigo-100 hover:bg-indigo-50/30 transition-all"
                    >
                      <div
                        className="h-8 w-8 rounded-lg shrink-0"
                        style={{ backgroundColor: project.color + "20" }}
                      >
                        <div className="h-full w-full flex items-center justify-center">
                          <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: project.color }} />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{project.name}</p>
                        <p className="text-xs text-gray-500">{project._count.tasks} tasks</p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

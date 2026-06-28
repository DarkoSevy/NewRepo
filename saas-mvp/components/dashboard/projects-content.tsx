"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Search, FolderKanban, MoreHorizontal, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { Organization, Project, MemberRole } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";

interface ProjectsContentProps {
  projects: (Project & {
    _count: { tasks: number };
    tasks: { id: string }[];
  })[];
  org: Organization;
  userRole: MemberRole;
}

const STATUS_COLORS = {
  ACTIVE: "bg-green-100 text-green-700",
  ARCHIVED: "bg-gray-100 text-gray-600",
  COMPLETED: "bg-blue-100 text-blue-700",
};

export function ProjectsContent({ projects, org, userRole }: ProjectsContentProps) {
  const [search, setSearch] = useState("");

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const canCreate = ["OWNER", "ADMIN", "MEMBER"].includes(userRole);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-500 mt-0.5">{projects.length} projects in {org.name}</p>
        </div>
        {canCreate && (
          <Link href="/dashboard/projects/new">
            <Button className="bg-indigo-600 hover:bg-indigo-700">
              <Plus className="h-4 w-4 mr-2" />
              New project
            </Button>
          </Link>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search projects..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-20 text-center">
          <FolderKanban className="h-12 w-12 text-gray-200 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 mb-1">
            {search ? "No projects found" : "No projects yet"}
          </h3>
          <p className="text-gray-500 mb-6">
            {search ? "Try a different search term." : "Create your first project to get started."}
          </p>
          {!search && canCreate && (
            <Link href="/dashboard/projects/new">
              <Button className="bg-indigo-600 hover:bg-indigo-700">
                <Plus className="h-4 w-4 mr-2" />
                Create project
              </Button>
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((project) => {
            const progress = project._count.tasks === 0
              ? 0
              : Math.round(((project._count.tasks - project.tasks.length) / project._count.tasks) * 100);

            return (
              <Link
                key={project.id}
                href={`/dashboard/projects/${project.id}`}
                className="group block"
              >
                <div className="bg-white rounded-xl border border-gray-100 p-5 hover:border-indigo-200 hover:shadow-md transition-all">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{ backgroundColor: project.color + "20" }}
                      >
                        <FolderKanban className="h-5 w-5" style={{ color: project.color }} />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-gray-900 group-hover:text-indigo-700 transition-colors truncate">
                          {project.name}
                        </h3>
                        <Badge
                          className={`text-xs mt-0.5 ${STATUS_COLORS[project.status]}`}
                          variant="secondary"
                        >
                          {project.status.toLowerCase()}
                        </Badge>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.preventDefault()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>
                          <Archive className="h-4 w-4 mr-2" /> Archive
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {project.description && (
                    <p className="text-sm text-gray-500 mb-4 line-clamp-2">{project.description}</p>
                  )}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500">{project.tasks.length} open · {project._count.tasks - project.tasks.length} done</span>
                      <span className="font-medium text-gray-700">{progress}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${progress}%`, backgroundColor: project.color }}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-gray-400 mt-3">
                    Updated {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, FolderKanban, Users, Settings,
  CreditCard, Bell, Layers, ChevronDown, Plus
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { getInitials } from "@/lib/utils";
import type { Organization, MemberRole } from "@prisma/client";

interface SidebarProps {
  org: Organization & { _count: { members: number; projects: number } };
  userRole: MemberRole;
}

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/projects", label: "Projects", icon: FolderKanban },
  { href: "/dashboard/members", label: "Members", icon: Users },
];

const BOTTOM_ITEMS = [
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
];

export function Sidebar({ org, userRole }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="w-64 flex flex-col bg-white border-r border-gray-200 shrink-0">
      {/* Logo + Org */}
      <div className="p-4 border-b border-gray-100">
        <button className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors text-left">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{org.name}</p>
            <p className="text-xs text-gray-500 capitalize">{org.plan.toLowerCase()} plan</p>
          </div>
          <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
        </button>
      </div>

      {/* Main nav */}
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}

        <div className="pt-4 pb-2">
          <div className="flex items-center justify-between px-3 mb-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Projects</p>
            {["OWNER", "ADMIN", "MEMBER"].includes(userRole) && (
              <Link href="/dashboard/projects/new">
                <button className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </Link>
            )}
          </div>
          <div className="space-y-0.5">
            <Link
              href="/dashboard/projects"
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors",
                pathname === "/dashboard/projects"
                  ? "text-indigo-700 font-medium"
                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
              )}
            >
              <FolderKanban className="h-3.5 w-3.5" />
              All projects
              <Badge variant="secondary" className="ml-auto text-xs py-0 h-5">
                {org._count.projects}
              </Badge>
            </Link>
          </div>
        </div>
      </nav>

      {/* Bottom nav */}
      <div className="p-3 border-t border-gray-100 space-y-0.5">
        {BOTTOM_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              pathname.startsWith(item.href)
                ? "bg-indigo-50 text-indigo-700"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        ))}
      </div>
    </aside>
  );
}

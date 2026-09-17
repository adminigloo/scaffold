"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import {
  FeedbackBoard,
  TicketPanel,
  type BoardTicketView,
} from "__SCOPE__/feedback/board";
import { api } from "@/trpc/client";
import { Button, EmptyState, PageHeader } from "@/components/ui";

/**
 * The Kanban view over the same tickets as /admin/feedback, plus the ticket
 * workspace panel (0.3.0): click a card for its conversation, status, and
 * assignee. All components ship in @__SCOPE_NAME__/feedback's ./board entry —
 * this page is the integration a consuming app writes: fetch through its own
 * gated procedures, hand data over, report intents back.
 *
 * 0.7.0 adds the serious-board controls: selection with bulk move (handing
 * the board `onMoveMany` is what turns it on), the archive sweep for
 * finished columns, and the eye toggle that shows archived cards greyed
 * instead of pretending they never happened.
 */
export default function FeedbackBoardPage() {
  const { user } = useUser();
  const currentUser =
    user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "staff";

  const [showArchived, setShowArchived] = useState(false);
  const board = api.feedback.board.useQuery({ includeArchived: showArchived });
  const move = api.feedback.move.useMutation();
  const moveMany = api.feedback.moveMany.useMutation();
  const archive = api.feedback.archive.useMutation();
  const unarchive = api.feedback.unarchive.useMutation();
  const archiveTerminal = api.feedback.archiveTerminal.useMutation();
  const addMessage = api.feedback.addMessage.useMutation();
  const assign = api.feedback.assign.useMutation();
  const markRead = api.feedback.markRead.useMutation();

  const [openId, setOpenId] = useState<string | null>(null);
  const messages = api.feedback.messages.useQuery(
    { ticketId: openId ?? "" },
    { enabled: openId !== null },
  );
  const openTicket: BoardTicketView | null =
    board.data?.tickets.find((ticket) => ticket.id === openId) ?? null;

  const handleMove = async (ticketId: string, statusKey: string) => {
    const result = await move.mutateAsync({ ticketId, statusKey });
    if (!result.moved) throw new Error("unknown status");
    await board.refetch();
  };

  const archivableCount = board.data?.archivableCount ?? 0;

  return (
    <>
      <PageHeader
        title="Feedback board"
        description="Drag a ticket between columns to change its status; click a card to open its conversation, status, and assignee."
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setShowArchived((current) => !current)}>
              {showArchived ? "Hide archived" : "Show archived"}
            </Button>
            {/* The month-three affordance: sweep every finished column in one
                click. The count comes from the server, not the visible page,
                so it is honest past the board's row cap. */}
            {archivableCount > 0 ? (
              <Button
                variant="primary"
                disabled={archiveTerminal.isPending}
                onClick={() =>
                  void archiveTerminal
                    .mutateAsync({ archivedBy: currentUser })
                    .then(() => board.refetch())
                }
              >
                {archiveTerminal.isPending
                  ? "Archiving…"
                  : `Archive done (${archivableCount})`}
              </Button>
            ) : null}
          </div>
        }
      />
      <p className="mb-4 text-sm text-ink-muted">
        Prefer the detail view?{" "}
        <Link href="/admin/feedback" className="text-accent underline underline-offset-2">
          Feedback list
        </Link>
      </p>

      {board.isLoading ? (
        <EmptyState title="Loading the board…">Fetching columns and tickets.</EmptyState>
      ) : board.error ? (
        <EmptyState title="The board did not load">{board.error.message}</EmptyState>
      ) : (
        <FeedbackBoard
          statuses={board.data?.statuses ?? []}
          tickets={board.data?.tickets ?? []}
          onMove={handleMove}
          onMoveMany={async (ticketIds, statusKey) => {
            const result = await moveMany.mutateAsync({ ticketIds, statusKey });
            if ("reason" in result) throw new Error("unknown status");
            await board.refetch();
          }}
          onOpen={(ticket) => {
            setOpenId(ticket.id);
            // Opening the workspace IS reading it: the card's "reply" pill
            // clears the way an inbox does — by looking, not by a chore.
            void markRead.mutateAsync({ ticketId: ticket.id }).then(() => board.refetch());
          }}
        />
      )}

      {openTicket ? (
        <TicketPanel
          ticket={openTicket}
          messages={messages.data ?? []}
          statuses={board.data?.statuses ?? []}
          currentUser={currentUser}
          onClose={() => setOpenId(null)}
          onSend={async (body) => {
            await addMessage.mutateAsync({
              ticketId: openTicket.id,
              senderName: currentUser,
              body,
            });
            await messages.refetch();
          }}
          onAssign={async (assignee) => {
            await assign.mutateAsync({
              ticketId: openTicket.id,
              assignee,
              actorName: currentUser,
            });
            await Promise.all([board.refetch(), messages.refetch()]);
          }}
          onMove={async (statusKey) => {
            await handleMove(openTicket.id, statusKey);
          }}
          onArchive={async () => {
            if (openTicket.archivedAt != null) {
              await unarchive.mutateAsync({ ticketId: openTicket.id });
            } else {
              await archive.mutateAsync({
                ticketId: openTicket.id,
                archivedBy: currentUser,
              });
              // An archived ticket leaves the default board; close the panel
              // rather than leaving it open over a card that just vanished.
              setOpenId(null);
            }
            await board.refetch();
          }}
        />
      ) : null}
    </>
  );
}

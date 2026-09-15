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
import { EmptyState, PageHeader } from "@/components/ui";

/**
 * The Kanban view over the same tickets as /admin/feedback, plus the ticket
 * workspace panel: click a card for its conversation, status, and assignee.
 *
 * All components ship in __SCOPE__/feedback's ./board entry — this page is the
 * integration a consuming app writes: fetch through its OWN gated procedures,
 * hand the data over, report intents back. The package never talks to a
 * network, which is what keeps the authorization rungs in `src/server/routers/
 * feedback.ts` the only door.
 */
export default function FeedbackBoardPage() {
  const { user } = useUser();
  const currentUser =
    user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "staff";

  const board = api.feedback.board.useQuery();
  const move = api.feedback.move.useMutation();
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

  return (
    <>
      <PageHeader
        title="Feedback board"
        description="Drag a ticket between columns to change its status; click a card to open its conversation, status, and assignee."
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
        />
      ) : null}
    </>
  );
}

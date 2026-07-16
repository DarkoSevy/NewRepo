-- The Phase 3 grants withheld DELETE on "matches" as defense in depth, but
-- deleting a PROPOSED match is a legitimate app operation: DELETE /matches/:id
-- and MatchesService.confirm()'s competing-proposal cleanup both do it.
-- Without this grant those paths fail with 42501 at runtime. The
-- trg_matches_immutable trigger still rejects deleting anything locked or
-- non-PROPOSED, which is the invariant that actually matters.
GRANT DELETE ON "matches" TO ledgercore_app;

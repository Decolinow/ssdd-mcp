import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

export interface TeamSummary {
  readonly projectId: string;
  readonly teamId: string;
  readonly name: string | null;
  readonly isConfigured: boolean;
  readonly currentVersion: number;
  readonly currentGeneration: number;
  readonly memberCount: number;
  readonly createdAt: string;
}

interface TeamSummaryRow {
  readonly project_id: string;
  readonly team_id: string;
  readonly current_version: number;
  readonly current_generation: number;
  readonly team_name: string | null;
  readonly member_count: number;
  readonly created_at: string;
}

export function listProjectTeams(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
): readonly TeamSummary[] {
  assertProjectAuthorization(database, projectId, principalId);
  return readProjectTeams(database, projectId);
}

export function readProjectTeams(database: SqliteDatabase, projectId: string): readonly TeamSummary[] {
  const rows = database.prepare(
    `SELECT team.project_id, team.team_id, team.current_version, team.current_generation,
            config.team_name,
            (SELECT COUNT(*) FROM team_member_capacities member
             WHERE member.project_id = team.project_id AND member.team_id = team.team_id
               AND member.config_version = team.current_version) AS member_count,
            team.created_at
     FROM teams team
     LEFT JOIN team_config_versions config ON config.project_id = team.project_id
       AND config.team_id = team.team_id AND config.version = team.current_version
     WHERE team.project_id = ? ORDER BY COALESCE(config.team_name, '') COLLATE NOCASE, team.team_id`,
  ).all(projectId) as TeamSummaryRow[];
  return rows.map((row) => ({
    projectId: row.project_id,
    teamId: row.team_id,
    name: row.team_name,
    isConfigured: row.current_version > 0,
    currentVersion: row.current_version,
    currentGeneration: row.current_generation,
    memberCount: row.member_count,
    createdAt: row.created_at,
  }));
}

/** Resolve the requested team or the only team in the project.
 * Omission is accepted only when the project has exactly one team.
 */
export function resolveProjectTeamId(
  database: SqliteDatabase,
  projectId: string,
  requestedTeamId?: string,
): string | null {
  const teams = readProjectTeams(database, projectId);
  if (requestedTeamId !== undefined) {
    const team = teams.find((candidate) => candidate.teamId === requestedTeamId);
    if (team === undefined) throw new ApplicationError("NOT_FOUND", "Team was not found in this project.");
    return team.teamId;
  }
  if (teams.length === 0) return null;
  if (teams.length === 1) return teams[0]!.teamId;
  throw new ApplicationError("VALIDATION_FAILED", "Select a team explicitly because this project has multiple teams.", {
    details: { teamOptions: teams },
  });
}


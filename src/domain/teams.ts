export interface TeamMemberCapacity {
  readonly principalId: string;
  readonly displayName: string;
  readonly dedicationPercent: number;
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
}

export interface TeamHoliday {
  readonly date: string;
  readonly label: string;
}

export interface TeamAbsence {
  readonly principalId: string;
  readonly date: string;
  readonly hours: number;
  readonly reason: string;
}

export interface TeamCapacityConfiguration {
  readonly projectId: string;
  readonly teamId: string;
  readonly generationNumber: number;
  readonly version: number;
  readonly teamName: string;
  readonly timezone: string;
  readonly hoursPerDay: number;
  readonly workingDays: readonly number[];
  readonly members: readonly TeamMemberCapacity[];
  readonly holidays: readonly TeamHoliday[];
  readonly absences: readonly TeamAbsence[];
  readonly reason: string;
  readonly configuredByPrincipalId: string;
  readonly configuredAt: string;
}

export interface TeamCapacityMemberResult extends TeamMemberCapacity {
  readonly activeWorkdays: number;
  readonly availableHours: number;
  readonly capacityLostToAbsenceHours: number;
}

export interface TeamCapacityDay {
  readonly date: string;
  readonly totalHours: number;
}

export interface TeamCapacityReport {
  readonly projectId: string;
  readonly teamId: string;
  readonly generationNumber: number;
  readonly teamName: string;
  readonly version: number;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly workdays: number;
  readonly totalHours: number;
  readonly members: readonly TeamCapacityMemberResult[];
  readonly daily: readonly TeamCapacityDay[];
}

export type MetricWipState = "ready" | "in_progress" | "in_review" | "in_validation";

export interface ScopeMetricPoint {
  readonly date: string;
  readonly scopePoints: number;
  readonly remainingPoints: number;
  readonly completedPoints: number;
  readonly cancelledPoints: number;
  readonly addedPoints: number;
  readonly removedPoints: number;
  readonly reestimatedPoints: number;
  readonly deliveryEventsPoints: number;
  readonly reopenedPoints: number;
  readonly reopenedItemCount: number;
  readonly wipByState: Readonly<Record<MetricWipState, number>>;
}

export interface SprintMetricPoint extends ScopeMetricPoint {
  readonly idealRemainingPoints: number | null;
}

export interface ScopeMetricItem {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly state: string;
  readonly points: number;
}

export interface SprintDeliveryMetrics {
  readonly projectId: string;
  readonly asOfDate: string;
  readonly watermarkSequence: number;
  readonly sprintId: string;
  readonly sprintKey: string;
  readonly status: "draft" | "active" | "closed" | "cancelled";
  readonly startsOn: string;
  readonly endsOn: string;
  readonly timezone: string;
  readonly teamGenerationNumber: number;
  readonly plannedScopePoints: number;
  readonly series: readonly SprintMetricPoint[];
  readonly items: readonly ScopeMetricItem[];
}

export interface MilestoneBurnupMetrics {
  readonly projectId: string;
  readonly asOfDate: string;
  readonly watermarkSequence: number;
  readonly milestoneId: string;
  readonly milestoneKey: string;
  readonly targetDate: string;
  readonly timezone: string;
  readonly series: readonly ScopeMetricPoint[];
  readonly items: readonly ScopeMetricItem[];
}

export interface SprintVelocityEntry {
  readonly sprintId: string;
  readonly sprintKey: string;
  readonly closedAt: string;
  readonly teamId: string;
  readonly teamGenerationNumber: number;
  readonly capacityHours: number;
  readonly deliveredPoints: number;
  readonly acceptedPbiCount: number;
  readonly pointsPerHour: number | null;
}

export interface TeamGenerationVelocity {
  readonly teamId: string;
  readonly generationNumber: number;
  readonly sprintCount: number;
  readonly totalDeliveredPoints: number;
  readonly averagePointsPerSprint: number;
  readonly medianPointsPerSprint: number;
}

export interface ProjectVelocityMetrics {
  readonly projectId: string;
  readonly observedAt: string;
  readonly watermarkSequence: number;
  readonly sampleSize: number;
  readonly sprints: readonly SprintVelocityEntry[];
  readonly byTeamGeneration: readonly TeamGenerationVelocity[];
}

export interface WipItemMetric {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly type: "story" | "bug" | "task";
  readonly state: MetricWipState;
  readonly assigneeId: string | null;
  readonly enteredStateAt: string;
  readonly ageDays: number;
  readonly openImpactCount: number;
}

export interface ProjectWipMetrics {
  readonly projectId: string;
  readonly observedAt: string;
  readonly watermarkSequence: number;
  readonly timezone: string;
  readonly totalWipCount: number;
  readonly blockedByOpenImpactCount: number;
  readonly countsByState: Readonly<Record<MetricWipState, number>>;
  readonly items: readonly WipItemMetric[];
  readonly itemsTruncated: boolean;
}

export interface PbiCoverageMetric {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly type: "story" | "bug";
  readonly state: string;
  readonly baselineId: string | null;
  readonly hasOpenImpact: boolean;
  readonly requiredCriteria: number;
  readonly coveredRequiredCriteria: number;
  readonly certifiedRequiredCriteria: number;
  readonly coveragePercent: number | null;
  readonly certifiedCoveragePercent: number | null;
}

export interface ProjectCoverageMetrics {
  readonly projectId: string;
  readonly observedAt: string;
  readonly watermarkSequence: number;
  readonly buildId: string | null;
  readonly requiredCriteria: number;
  readonly coveredRequiredCriteria: number;
  readonly certifiedRequiredCriteria: number;
  readonly coveragePercent: number | null;
  readonly certifiedCoveragePercent: number | null;
  readonly pinnedPbiCount: number;
  readonly previewPbiCount: number;
  readonly itemsTotal: number;
  readonly itemsTruncated: boolean;
  readonly items: readonly PbiCoverageMetric[];
}

export type ForecastStatus = "complete" | "incomplete_scope" | "blocked" | "insufficient_data" | "no_capacity" | "zero_velocity" | "forecast_ready";
export type ForecastScenarioKey = "cautious" | "base" | "favorable";
export type ForecastScenarioStatus = ForecastStatus | "horizon_exceeded";

export interface ForecastVelocitySampleV1 {
  readonly sprintId: string;
  readonly sprintKey: string;
  readonly closedAt: string;
  readonly deliveredPoints: number;
  readonly capacityHours: number;
  readonly pointsPerHour: number;
}

export interface ForecastVelocitySample {
  readonly sprintId: string;
  readonly sprintKey: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly closedAt: string;
  readonly deliveredPoints: number;
  readonly capacityHours: number;
}

export interface ForecastCapacityBasis {
  readonly source: "active_sprint_snapshot" | "planned_sprint_configuration" | "team_configuration_assumption";
  readonly sprintId: string | null;
  readonly sprintKey: string | null;
  readonly configVersion: number;
  readonly startDate: string;
  readonly endDate: string;
}

export interface ForecastScenarioV1 {
  readonly key: ForecastScenarioKey;
  readonly percentile: 25 | 50 | 75;
  readonly pointsPerHour: number | null;
  readonly hoursNeeded: number | null;
  readonly workingDaysToComplete: number | null;
  readonly estimatedDate: string | null;
  readonly onTime: boolean | null;
  readonly status: ForecastScenarioStatus;
}

export interface ForecastScenario {
  readonly key: ForecastScenarioKey;
  readonly percentile: 25 | 50 | 75;
  readonly estimatedDate: string | null;
  readonly workingDaysToComplete: number | null;
  readonly onTime: boolean | null;
  readonly status: ForecastScenarioStatus;
}

export interface ForecastExternalDependencyBlocker {
  readonly kind: "external_dependency";
  readonly itemId: string;
  readonly itemKey: string;
  readonly dependencyItemId: string;
  readonly dependencyItemKey: string;
  readonly dependencyState: string;
  readonly resolutionDate: null;
}

export interface ForecastImpactBlocker {
  readonly kind: "open_specification_impact";
  readonly itemId: string;
  readonly itemKey: string;
  readonly impactId: string;
  readonly specificationKey: string;
  readonly publishedRevision: number;
}

export type ForecastBlocker = ForecastExternalDependencyBlocker | ForecastImpactBlocker;

export interface ForecastInternalDependencyRisk {
  readonly kind: "internal_dependency";
  readonly itemId: string;
  readonly itemKey: string;
  readonly dependencyItemId: string;
  readonly dependencyItemKey: string;
  readonly dependencyState: string;
}

export interface ForecastCapacityDay {
  readonly date: string;
  readonly hours: number;
  readonly source: ForecastCapacityBasis["source"];
  readonly sprintId: string | null;
  readonly sprintKey: string | null;
  readonly configVersion: number;
}

export interface ForecastCalculationInputV1 {
  readonly asOfDate: string;
  readonly targetDate: string;
  readonly remainingPoints: number;
  readonly unestimatedPbiCount: number;
  readonly sample: readonly ForecastVelocitySampleV1[];
  readonly capacityDays: readonly ForecastCapacityDay[];
  readonly blockers: readonly ForecastBlocker[];
}

export interface ForecastCalculationInput {
  readonly asOfDate: string;
  readonly targetDate: string;
  readonly remainingPoints: number;
  readonly unestimatedPbiCount: number;
  readonly teamId: string | null;
  readonly teamGenerationNumber: number | null;
  readonly sample: readonly ForecastVelocitySample[];
  readonly capacityDays: readonly ForecastCapacityDay[];
  readonly blockers: readonly ForecastBlocker[];
  readonly seed: number;
  readonly simulationCount: number;
  readonly typicalSprintDurationCalendarDays: number | null;
}

export interface MilestoneForecastSnapshotV1 {
  readonly forecastId: string;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly milestoneKey: string;
  readonly targetDate: string;
  readonly asOfDate: string;
  readonly watermarkSequence: number;
  readonly calculatedAt: string;
  readonly algorithmVersion: string;
  readonly status: ForecastStatus;
  readonly remainingPoints: number;
  readonly openPbiCount: number;
  readonly unestimatedPbiCount: number;
  readonly teamId: string | null;
  readonly teamGenerationNumber: number | null;
  readonly minimumSampleSize: number;
  readonly sample: readonly ForecastVelocitySampleV1[];
  readonly percentiles: Readonly<Record<ForecastScenarioKey, { readonly percentile: 25 | 50 | 75; readonly pointsPerHour: number | null }>>;
  readonly capacityStartDate: string;
  readonly capacityEndDate: string;
  readonly capacityHoursInHorizon: number;
  readonly capacityBases: readonly ForecastCapacityBasis[];
  readonly blockers: readonly ForecastBlocker[];
  readonly risks: readonly ForecastInternalDependencyRisk[];
  readonly scenarios: readonly ForecastScenarioV1[];
}

export interface MilestoneForecastSnapshot {
  readonly forecastId: string;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly milestoneKey: string;
  readonly targetDate: string;
  readonly asOfDate: string;
  readonly watermarkSequence: number;
  readonly calculatedAt: string;
  readonly algorithmVersion: "2.0.0";
  readonly status: ForecastStatus;
  readonly remainingPoints: number;
  readonly openPbiCount: number;
  readonly unestimatedPbiCount: number;
  readonly teamId: string | null;
  readonly teamGenerationNumber: number | null;
  readonly minimumSampleSize: number;
  readonly sample: readonly ForecastVelocitySample[];
  readonly seed: number;
  readonly simulationCount: number;
  readonly typicalSprintDurationCalendarDays: number | null;
  readonly targetDateWithinHorizon: boolean;
  readonly probabilityOnTime: number | null;
  readonly percentiles: Readonly<Record<ForecastScenarioKey, {
    readonly percentile: 25 | 50 | 75;
    readonly estimatedDate: string | null;
    readonly workingDaysToComplete: number | null;
  }>>;
  readonly capacityStartDate: string;
  readonly capacityEndDate: string;
  readonly capacityHoursInHorizon: number;
  readonly capacityBases: readonly ForecastCapacityBasis[];
  readonly blockers: readonly ForecastBlocker[];
  readonly risks: readonly ForecastInternalDependencyRisk[];
  readonly scenarios: readonly ForecastScenario[];
}

export interface MilestoneForecastHistoryEntry {
  readonly forecast: MilestoneForecastSnapshot | MilestoneForecastSnapshotV1;
  readonly calculationInput: ForecastCalculationInput | ForecastCalculationInputV1;
}

export interface MilestoneForecastRecalculation {
  readonly forecastId: string;
  readonly algorithmVersion: string;
  readonly recalculatedAt: string;
  readonly status: ForecastStatus;
  readonly percentiles: MilestoneForecastSnapshot["percentiles"] | MilestoneForecastSnapshotV1["percentiles"];
  readonly scenarios: readonly (ForecastScenario | ForecastScenarioV1)[];
  readonly probabilityOnTime: number | null;
  readonly seed: number | null;
  readonly simulationCount: number | null;
}

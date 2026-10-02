// Release control: ordinary builds must not activate dependent viewer reads.
export const PIPELINE_VIEWER_ENABLED = typeof __FLIGHTDECK_PIPELINE_VIEWER_ENABLED__ !== 'undefined'
  && __FLIGHTDECK_PIPELINE_VIEWER_ENABLED__ === true;

// Central definitions for all vehicle types.
// Add new types here; Vehicle.js and Enemy.js read stats from this table.

export const VehicleType = {
    LURCHER:       'lurcher',
    // FIREBRAT: 'firebrat',
    // JOTUN:    'jotun',
    // VALKYRIE: 'valkyrie',
};

export const VEHICLE_DEFS = {

    lurcher: {
        label:          'LURCHER',
        health:         5,
        speed:          5.5,
        turnRate:       9,      // rotation lerp factor (higher = snappier)
        shootInterval:  0.45,   // seconds between player shots
        // Strengths:  balanced all-rounder, comfortable at any range
        // Weaknesses: no special terrain or mobility advantages
    },

    // firebrat: {
    //     label:          'FIREBRAT',
    //     health:         2,
    //     speed:          10,
    //     turnRate:       14,
    //     shootInterval:  0.65,
    //     // Strengths:  fastest unit — ideal for grabbing the flag and running
    //     // Weaknesses: fragile, weak firepower, dies quickly in a straight fight
    // },

    // jotun: {
    //     label:          'JOTUN',
    //     health:         10,
    //     speed:          2.5,
    //     turnRate:       4,
    //     shootInterval:  1.8,
    //     // Strengths:  enormous HP, cannon hits hard and at long range
    //     // Weaknesses: very slow, easy to outmanoeuvre, poor at chasing
    // },

    // valkyrie: {
    //     label:          'VALKYRIE',
    //     health:         4,
    //     speed:          6,
    //     turnRate:       10,
    //     shootInterval:  0.55,
    //     // Strengths:  ignores terrain — can cross rock, mountain, and water tiles
    //     // Weaknesses: average combat stats, no armour advantage
    // },

};

export interface Discovery {
    files: string[];
    /** Where the list came from, for messages. */
    source: 'firebase.json' | 'search';
}
/**
 * Finds rules files the way the Firebase CLI would: from firebase.json
 * ("firestore" and "storage" entries), falling back to any *.rules file.
 */
export declare function discoverRulesFiles(cwd: string): Discovery;

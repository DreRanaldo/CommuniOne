
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "alert_events": {
                  Row: {
                    "actor_user_id": string | null,"alert_id": string,"community_id": string,"dispatched_at": string | null,"event_type": string,"id": string,"occurred_at": string,"severity": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_user_id"?: string | null,"alert_id": string,"community_id": string,"dispatched_at"?: string | null,"event_type": string,"id"?: string,"occurred_at"?: string,"severity": string
                  }
                  Update: {
                    "actor_user_id"?: string | null,"alert_id"?: string,"community_id"?: string,"dispatched_at"?: string | null,"event_type"?: string,"id"?: string,"occurred_at"?: string,"severity"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alert_events_actor_user_id_fkey"
      columns: ["actor_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alert_events_alert_id_fkey"
      columns: ["alert_id"]
isOneToOne: false
      referencedRelation: "alerts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alert_events_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"alerts": {
                  Row: {
                    "archived_at": string | null,"body": string,"cancellation_reason": string | null,"cancelled_at": string | null,"cancelled_by": string | null,"community_id": string,"created_at": string,"created_by": string | null,"edited_at": string | null,"expired_at": string | null,"expires_at": string | null,"id": string,"image_path": string | null,"is_emergency": boolean | null,"latitude": number | null,"location_accuracy_m": number | null,"longitude": number | null,"published_at": string | null,"published_by": string | null,"severity": string,"severity_rank": number | null,"status": string,"title": string,"updated_at": string,"updated_by_user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"body": string,"cancellation_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"community_id": string,"created_at"?: string,"created_by"?: string | null,"edited_at"?: string | null,"expired_at"?: string | null,"expires_at"?: string | null,"id"?: string,"image_path"?: string | null,"is_emergency"?: never,"latitude"?: number | null,"location_accuracy_m"?: number | null,"longitude"?: number | null,"published_at"?: string | null,"published_by"?: string | null,"severity"?: string,"severity_rank"?: never,"status"?: string,"title": string,"updated_at"?: string,"updated_by_user_id"?: string | null
                  }
                  Update: {
                    "archived_at"?: string | null,"body"?: string,"cancellation_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"community_id"?: string,"created_at"?: string,"created_by"?: string | null,"edited_at"?: string | null,"expired_at"?: string | null,"expires_at"?: string | null,"id"?: string,"image_path"?: string | null,"is_emergency"?: never,"latitude"?: number | null,"location_accuracy_m"?: number | null,"longitude"?: number | null,"published_at"?: string | null,"published_by"?: string | null,"severity"?: string,"severity_rank"?: never,"status"?: string,"title"?: string,"updated_at"?: string,"updated_by_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "alerts_cancelled_by_fkey"
      columns: ["cancelled_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alerts_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alerts_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alerts_published_by_fkey"
      columns: ["published_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alerts_updated_by_user_id_fkey"
      columns: ["updated_by_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"announcements": {
                  Row: {
                    "archived_at": string | null,"author_user_id": string | null,"body": string,"community_id": string,"created_at": string,"edited_at": string | null,"expires_at": string | null,"id": string,"priority": string,"published_at": string | null,"status": string,"title": string,"updated_at": string,"updated_by_user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"author_user_id"?: string | null,"body": string,"community_id": string,"created_at"?: string,"edited_at"?: string | null,"expires_at"?: string | null,"id"?: string,"priority"?: string,"published_at"?: string | null,"status"?: string,"title": string,"updated_at"?: string,"updated_by_user_id"?: string | null
                  }
                  Update: {
                    "archived_at"?: string | null,"author_user_id"?: string | null,"body"?: string,"community_id"?: string,"created_at"?: string,"edited_at"?: string | null,"expires_at"?: string | null,"id"?: string,"priority"?: string,"published_at"?: string | null,"status"?: string,"title"?: string,"updated_at"?: string,"updated_by_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "announcements_author_user_id_fkey"
      columns: ["author_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "announcements_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "announcements_updated_by_user_id_fkey"
      columns: ["updated_by_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_actions": {
                  Row: {
                    "action": string,"description": string,"entity_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"description": string,"entity_type": string
                  }
                  Update: {
                    "action"?: string,"description"?: string,"entity_type"?: string
                  }
                  Relationships: [
                    
                  ]
                },"audit_logs": {
                  Row: {
                    "action": string,"actor_user_id": string | null,"community_id": string | null,"created_at": string,"entity_id": string | null,"entity_type": string,"id": string,"metadata": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id"?: string | null,"community_id"?: string | null,"created_at"?: string,"entity_id"?: string | null,"entity_type": string,"id"?: string,"metadata"?: NonNullable<Json>
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string | null,"community_id"?: string | null,"created_at"?: string,"entity_id"?: string | null,"entity_type"?: string,"id"?: string,"metadata"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_logs_action_fkey"
      columns: ["action"]
isOneToOne: false
      referencedRelation: "audit_actions"
      referencedColumns: ["action"]
    }
                  ]
                },"comments": {
                  Row: {
                    "author_user_id": string | null,"body": string,"community_id": string,"created_at": string,"depth": number,"edited_at": string | null,"id": string,"moderated_at": string | null,"moderated_by_user_id": string | null,"moderation_reason": string | null,"parent_comment_id": string | null,"post_id": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_user_id"?: string | null,"body": string,"community_id": string,"created_at"?: string,"depth"?: number,"edited_at"?: string | null,"id"?: string,"moderated_at"?: string | null,"moderated_by_user_id"?: string | null,"moderation_reason"?: string | null,"parent_comment_id"?: string | null,"post_id": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "author_user_id"?: string | null,"body"?: string,"community_id"?: string,"created_at"?: string,"depth"?: number,"edited_at"?: string | null,"id"?: string,"moderated_at"?: string | null,"moderated_by_user_id"?: string | null,"moderation_reason"?: string | null,"parent_comment_id"?: string | null,"post_id"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "comments_author_user_id_fkey"
      columns: ["author_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "comments_moderated_by_user_id_fkey"
      columns: ["moderated_by_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "comments_parent_fk"
      columns: ["parent_comment_id","post_id"]
isOneToOne: false
      referencedRelation: "comments"
      referencedColumns: ["id","post_id"]
    },{
      foreignKeyName: "comments_post_fk"
      columns: ["post_id","community_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"communities": {
                  Row: {
                    "community_type": string,"cover_image_path": string | null,"cover_image_url": string | null,"created_at": string,"created_by": string | null,"description": string | null,"id": string,"logo_path": string | null,"logo_url": string | null,"name": string,"settings": NonNullable<Json>,"slug": string,"status": string,"timezone": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_type"?: string,"cover_image_path"?: string | null,"cover_image_url"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"logo_path"?: string | null,"logo_url"?: string | null,"name": string,"settings"?: NonNullable<Json>,"slug": string,"status"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "community_type"?: string,"cover_image_path"?: string | null,"cover_image_url"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"logo_path"?: string | null,"logo_url"?: string | null,"name"?: string,"settings"?: NonNullable<Json>,"slug"?: string,"status"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"community_notification_settings": {
                  Row: {
                    "alerts": boolean,"announcements": boolean,"comments": boolean,"community_id": string,"events": boolean,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alerts"?: boolean,"announcements"?: boolean,"comments"?: boolean,"community_id": string,"events"?: boolean,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "alerts"?: boolean,"announcements"?: boolean,"comments"?: boolean,"community_id"?: string,"events"?: boolean,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "community_notification_settings_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "community_notification_settings_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"document_folders": {
                  Row: {
                    "community_id": string,"created_at": string,"created_by": string | null,"id": string,"name": string,"parent_folder_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"parent_folder_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"parent_folder_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_folders_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_folders_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "document_folders_parent_fk"
      columns: ["parent_folder_id","community_id"]
isOneToOne: false
      referencedRelation: "document_folders"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"document_mime_types": {
                  Row: {
                    "enabled": boolean,"extension": string,"mime_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "enabled"?: boolean,"extension": string,"mime_type": string
                  }
                  Update: {
                    "enabled"?: boolean,"extension"?: string,"mime_type"?: string
                  }
                  Relationships: [
                    
                  ]
                },"document_upload_settings": {
                  Row: {
                    "id": boolean,"max_file_size_bytes": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: boolean,"max_file_size_bytes"?: number,"updated_at"?: string
                  }
                  Update: {
                    "id"?: boolean,"max_file_size_bytes"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"documents": {
                  Row: {
                    "archived_at": string | null,"community_id": string,"created_at": string,"deleted_at": string | null,"file_extension": string,"file_purged_at": string | null,"file_size": number,"folder_id": string | null,"id": string,"mime_type": string,"name": string,"status": string,"storage_path": string | null,"updated_at": string,"updated_by_user_id": string | null,"uploaded_at": string | null,"uploaded_by": string | null,"visibility": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"community_id": string,"created_at"?: string,"deleted_at"?: string | null,"file_extension": string,"file_purged_at"?: string | null,"file_size": number,"folder_id"?: string | null,"id"?: string,"mime_type": string,"name": string,"status"?: string,"storage_path"?: never,"updated_at"?: string,"updated_by_user_id"?: string | null,"uploaded_at"?: string | null,"uploaded_by"?: string | null,"visibility"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"community_id"?: string,"created_at"?: string,"deleted_at"?: string | null,"file_extension"?: string,"file_purged_at"?: string | null,"file_size"?: number,"folder_id"?: string | null,"id"?: string,"mime_type"?: string,"name"?: string,"status"?: string,"storage_path"?: never,"updated_at"?: string,"updated_by_user_id"?: string | null,"uploaded_at"?: string | null,"uploaded_by"?: string | null,"visibility"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "documents_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documents_folder_fk"
      columns: ["folder_id","community_id"]
isOneToOne: false
      referencedRelation: "document_folders"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "documents_mime_type_fkey"
      columns: ["mime_type"]
isOneToOne: false
      referencedRelation: "document_mime_types"
      referencedColumns: ["mime_type"]
    },{
      foreignKeyName: "documents_updated_by_user_id_fkey"
      columns: ["updated_by_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documents_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"event_rsvps": {
                  Row: {
                    "community_id": string,"created_at": string,"event_id": string,"id": string,"status": string,"updated_at": string,"user_id": string,"waitlisted_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"event_id": string,"id"?: string,"status": string,"updated_at"?: string,"user_id"?: string,"waitlisted_at"?: string | null
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"status"?: string,"updated_at"?: string,"user_id"?: string,"waitlisted_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_rsvps_event_fk"
      columns: ["event_id","community_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "event_rsvps_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"events": {
                  Row: {
                    "cancellation_reason": string | null,"cancelled_at": string | null,"cancelled_by": string | null,"capacity": number | null,"community_id": string,"completed_at": string | null,"created_at": string,"created_by": string | null,"description": string | null,"edited_at": string | null,"ends_at": string,"id": string,"location_text": string | null,"published_at": string | null,"rsvp_changed_at": string | null,"starts_at": string,"status": string,"timezone": string,"title": string,"updated_at": string,"updated_by_user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "cancellation_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"capacity"?: number | null,"community_id": string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"edited_at"?: string | null,"ends_at": string,"id"?: string,"location_text"?: string | null,"published_at"?: string | null,"rsvp_changed_at"?: string | null,"starts_at": string,"status"?: string,"timezone"?: string,"title": string,"updated_at"?: string,"updated_by_user_id"?: string | null
                  }
                  Update: {
                    "cancellation_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"capacity"?: number | null,"community_id"?: string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"edited_at"?: string | null,"ends_at"?: string,"id"?: string,"location_text"?: string | null,"published_at"?: string | null,"rsvp_changed_at"?: string | null,"starts_at"?: string,"status"?: string,"timezone"?: string,"title"?: string,"updated_at"?: string,"updated_by_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "events_cancelled_by_fkey"
      columns: ["cancelled_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "events_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "events_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "events_updated_by_user_id_fkey"
      columns: ["updated_by_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"favorites": {
                  Row: {
                    "community_id": string,"created_at": string,"listing_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"listing_id": string,"user_id": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"listing_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "favorites_listing_fkey"
      columns: ["listing_id","community_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "favorites_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"inventory": {
                  Row: {
                    "community_id": string,"listing_id": string,"on_hand": number,"reserved": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"listing_id": string,"on_hand"?: number,"reserved"?: number,"updated_at"?: string
                  }
                  Update: {
                    "community_id"?: string,"listing_id"?: string,"on_hand"?: number,"reserved"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inventory_listing_fkey"
      columns: ["listing_id","community_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"inventory_movements": {
                  Row: {
                    "actor_user_id": string | null,"community_id": string,"created_at": string,"delta": number,"id": string,"listing_id": string,"note": string | null,"on_hand_after": number,"reason": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_user_id"?: string | null,"community_id": string,"created_at"?: string,"delta": number,"id"?: string,"listing_id": string,"note"?: string | null,"on_hand_after": number,"reason": string
                  }
                  Update: {
                    "actor_user_id"?: string | null,"community_id"?: string,"created_at"?: string,"delta"?: number,"id"?: string,"listing_id"?: string,"note"?: string | null,"on_hand_after"?: number,"reason"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inventory_movements_actor_user_id_fkey"
      columns: ["actor_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "inventory_movements_listing_id_fkey"
      columns: ["listing_id"]
isOneToOne: false
      referencedRelation: "inventory"
      referencedColumns: ["listing_id"]
    }
                  ]
                },"invitation_redemptions": {
                  Row: {
                    "community_id": string,"id": string,"invitation_id": string,"membership_id": string | null,"redeemed_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"id"?: string,"invitation_id": string,"membership_id"?: string | null,"redeemed_at"?: string,"user_id": string
                  }
                  Update: {
                    "community_id"?: string,"id"?: string,"invitation_id"?: string,"membership_id"?: string | null,"redeemed_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitation_redemptions_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitation_redemptions_invitation_id_fkey"
      columns: ["invitation_id"]
isOneToOne: false
      referencedRelation: "invitations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitation_redemptions_membership_id_fkey"
      columns: ["membership_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitation_redemptions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"invitations": {
                  Row: {
                    "community_id": string,"created_at": string,"created_by": string | null,"expires_at": string,"id": string,"max_uses": number | null,"revoked_at": string | null,"revoked_by": string | null,"status": string,"token_hash": string,"updated_at": string,"use_count": number
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"created_by"?: string | null,"expires_at": string,"id"?: string,"max_uses"?: number | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"status"?: string,"token_hash": string,"updated_at"?: string,"use_count"?: number
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string,"id"?: string,"max_uses"?: number | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"status"?: string,"token_hash"?: string,"updated_at"?: string,"use_count"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitations_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitations_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitations_revoked_by_fkey"
      columns: ["revoked_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"listing_images": {
                  Row: {
                    "community_id": string,"created_at": string,"height": number,"id": string,"listing_id": string,"position": number,"storage_path": string,"width": number
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"height": number,"id"?: string,"listing_id": string,"position": number,"storage_path": string,"width": number
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"height"?: number,"id"?: string,"listing_id"?: string,"position"?: number,"storage_path"?: string,"width"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "listing_images_listing_fkey"
      columns: ["listing_id","community_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"listings": {
                  Row: {
                    "category_id": string,"community_id": string,"condition": string | null,"created_at": string,"currency": string,"description": string,"fulfillment": (string)[],"id": string,"kind": string,"pickup_area": string | null,"price_minor": number | null,"pricing": string,"published_at": string | null,"removal_reason": string | null,"removed_by": string | null,"search": unknown,"seller_profile_id": string,"seller_user_id": string,"service_area": string | null,"status": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"community_id": string,"condition"?: string | null,"created_at"?: string,"currency"?: string,"description"?: string,"fulfillment"?: (string)[],"id"?: string,"kind": string,"pickup_area"?: string | null,"price_minor"?: number | null,"pricing"?: string,"published_at"?: string | null,"removal_reason"?: string | null,"removed_by"?: string | null,"search"?: never,"seller_profile_id": string,"seller_user_id": string,"service_area"?: string | null,"status"?: string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "category_id"?: string,"community_id"?: string,"condition"?: string | null,"created_at"?: string,"currency"?: string,"description"?: string,"fulfillment"?: (string)[],"id"?: string,"kind"?: string,"pickup_area"?: string | null,"price_minor"?: number | null,"pricing"?: string,"published_at"?: string | null,"removal_reason"?: string | null,"removed_by"?: string | null,"search"?: never,"seller_profile_id"?: string,"seller_user_id"?: string,"service_area"?: string | null,"status"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "listings_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "market_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "listings_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "listings_removed_by_fkey"
      columns: ["removed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "listings_seller_profile_fkey"
      columns: ["seller_profile_id","community_id"]
isOneToOne: false
      referencedRelation: "seller_profiles"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "listings_seller_user_id_fkey"
      columns: ["seller_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"market_categories": {
                  Row: {
                    "active": boolean,"icon": string | null,"id": string,"kind": string,"name": string,"parent_id": string | null,"slug": string,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"icon"?: string | null,"id"?: string,"kind": string,"name": string,"parent_id"?: string | null,"slug": string,"sort_order"?: number
                  }
                  Update: {
                    "active"?: boolean,"icon"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"parent_id"?: string | null,"slug"?: string,"sort_order"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "market_categories_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "market_categories"
      referencedColumns: ["id"]
    }
                  ]
                },"membership_roles": {
                  Row: {
                    "community_id": string,"created_at": string,"id": string,"membership_id": string,"role_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"id"?: string,"membership_id": string,"role_id": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"membership_id"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_roles_membership_fk"
      columns: ["membership_id","community_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "membership_roles_role_fk"
      columns: ["role_id","community_id"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"memberships": {
                  Row: {
                    "community_id": string,"created_at": string,"id": string,"joined_at": string | null,"status": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"id"?: string,"joined_at"?: string | null,"status"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"joined_at"?: string | null,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "memberships_user_profile_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_types": {
                  Row: {
                    "created_at": string,"default_priority": string,"description": string,"key": string,"requires_membership": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"default_priority"?: string,"description": string,"key": string,"requires_membership"?: boolean
                  }
                  Update: {
                    "created_at"?: string,"default_priority"?: string,"description"?: string,"key"?: string,"requires_membership"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"notifications": {
                  Row: {
                    "archived_at": string | null,"body": string | null,"community_id": string | null,"created_at": string,"data": NonNullable<Json>,"dedupe_key": string | null,"id": string,"read_at": string | null,"title": string,"type": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"body"?: string | null,"community_id"?: string | null,"created_at"?: string,"data"?: NonNullable<Json>,"dedupe_key"?: string | null,"id"?: string,"read_at"?: string | null,"title": string,"type": string,"user_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"body"?: string | null,"community_id"?: string | null,"created_at"?: string,"data"?: NonNullable<Json>,"dedupe_key"?: string | null,"id"?: string,"read_at"?: string | null,"title"?: string,"type"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_type_fkey"
      columns: ["type"]
isOneToOne: false
      referencedRelation: "notification_types"
      referencedColumns: ["key"]
    },{
      foreignKeyName: "notifications_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"permissions": {
                  Row: {
                    "created_at": string,"description": string,"id": string,"key": string,"module": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description": string,"id"?: string,"key": string,"module": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string,"id"?: string,"key"?: string,"module"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_admins": {
                  Row: {
                    "created_at": string,"granted_by": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"granted_by"?: string | null,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"granted_by"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"post_images": {
                  Row: {
                    "community_id": string,"created_at": string,"height": number,"id": string,"position": number,"post_id": string,"storage_path": string,"width": number
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"height": number,"id"?: string,"position": number,"post_id": string,"storage_path": string,"width": number
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"height"?: number,"id"?: string,"position"?: number,"post_id"?: string,"storage_path"?: string,"width"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "post_images_post_fkey"
      columns: ["post_id","community_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"posts": {
                  Row: {
                    "author_user_id": string | null,"body": string,"client_request_id": string | null,"community_id": string,"created_at": string,"edited_at": string | null,"id": string,"moderated_at": string | null,"moderated_by_user_id": string | null,"moderation_reason": string | null,"status": string,"updated_at": string,"visibility": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_user_id"?: string | null,"body": string,"client_request_id"?: string | null,"community_id": string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"moderated_at"?: string | null,"moderated_by_user_id"?: string | null,"moderation_reason"?: string | null,"status"?: string,"updated_at"?: string,"visibility"?: string
                  }
                  Update: {
                    "author_user_id"?: string | null,"body"?: string,"client_request_id"?: string | null,"community_id"?: string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"moderated_at"?: string | null,"moderated_by_user_id"?: string | null,"moderation_reason"?: string | null,"status"?: string,"updated_at"?: string,"visibility"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "posts_author_user_id_fkey"
      columns: ["author_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "posts_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "posts_moderated_by_user_id_fkey"
      columns: ["moderated_by_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profile_private": {
                  Row: {
                    "created_at": string,"phone": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"phone"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "created_at"?: string,"phone"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profile_private_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_path": string | null,"avatar_url": string | null,"bio": string | null,"created_at": string,"display_name": string | null,"first_name": string | null,"id": string,"last_name": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_path"?: string | null,"avatar_url"?: string | null,"bio"?: string | null,"created_at"?: string,"display_name"?: string | null,"first_name"?: string | null,"id": string,"last_name"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "avatar_path"?: string | null,"avatar_url"?: string | null,"bio"?: string | null,"created_at"?: string,"display_name"?: string | null,"first_name"?: string | null,"id"?: string,"last_name"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reactions": {
                  Row: {
                    "comment_id": string | null,"community_id": string,"created_at": string,"id": string,"post_id": string | null,"reaction_type": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "comment_id"?: string | null,"community_id": string,"created_at"?: string,"id"?: string,"post_id"?: string | null,"reaction_type": string,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "comment_id"?: string | null,"community_id"?: string,"created_at"?: string,"id"?: string,"post_id"?: string | null,"reaction_type"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reactions_comment_fk"
      columns: ["comment_id","community_id"]
isOneToOne: false
      referencedRelation: "comments"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "reactions_post_fk"
      columns: ["post_id","community_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "reactions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"role_permissions": {
                  Row: {
                    "permission_id": string,"role_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "permission_id": string,"role_id": string
                  }
                  Update: {
                    "permission_id"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "role_permissions_permission_id_fkey"
      columns: ["permission_id"]
isOneToOne: false
      referencedRelation: "permissions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "role_permissions_role_id_fkey"
      columns: ["role_id"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["id"]
    }
                  ]
                },"role_template_permissions": {
                  Row: {
                    "permission_id": string,"template_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "permission_id": string,"template_id": string
                  }
                  Update: {
                    "permission_id"?: string,"template_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "role_template_permissions_permission_id_fkey"
      columns: ["permission_id"]
isOneToOne: false
      referencedRelation: "permissions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "role_template_permissions_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "role_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"role_templates": {
                  Row: {
                    "assign_to_creator": boolean,"assign_to_new_members": boolean,"created_at": string,"description": string | null,"id": string,"key": string,"name": string,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "assign_to_creator"?: boolean,"assign_to_new_members"?: boolean,"created_at"?: string,"description"?: string | null,"id"?: string,"key": string,"name": string,"sort_order"?: number
                  }
                  Update: {
                    "assign_to_creator"?: boolean,"assign_to_new_members"?: boolean,"created_at"?: string,"description"?: string | null,"id"?: string,"key"?: string,"name"?: string,"sort_order"?: number
                  }
                  Relationships: [
                    
                  ]
                },"roles": {
                  Row: {
                    "community_id": string,"created_at": string,"description": string | null,"id": string,"is_default_for_new_members": boolean,"is_system_role": boolean,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_default_for_new_members"?: boolean,"is_system_role"?: boolean,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_default_for_new_members"?: boolean,"is_system_role"?: boolean,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roles_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"seller_profiles": {
                  Row: {
                    "bio": string | null,"community_id": string,"created_at": string,"display_name": string,"id": string,"status": string,"updated_at": string,"user_id": string,"verification_status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "bio"?: string | null,"community_id": string,"created_at"?: string,"display_name": string,"id"?: string,"status"?: string,"updated_at"?: string,"user_id": string,"verification_status"?: string
                  }
                  Update: {
                    "bio"?: string | null,"community_id"?: string,"created_at"?: string,"display_name"?: string,"id"?: string,"status"?: string,"updated_at"?: string,"user_id"?: string,"verification_status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "seller_profiles_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "seller_profiles_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"stories": {
                  Row: {
                    "author_user_id": string,"caption": string | null,"client_request_id": string | null,"community_id": string,"created_at": string,"deleted_at": string | null,"deleted_by": string | null,"expires_at": string,"height": number,"id": string,"storage_path": string,"width": number
                  }
                  ComputedFields: never
                  Insert: {
                    "author_user_id": string,"caption"?: string | null,"client_request_id"?: string | null,"community_id": string,"created_at"?: string,"deleted_at"?: string | null,"deleted_by"?: string | null,"expires_at"?: string,"height": number,"id"?: string,"storage_path": string,"width": number
                  }
                  Update: {
                    "author_user_id"?: string,"caption"?: string | null,"client_request_id"?: string | null,"community_id"?: string,"created_at"?: string,"deleted_at"?: string | null,"deleted_by"?: string | null,"expires_at"?: string,"height"?: number,"id"?: string,"storage_path"?: string,"width"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "stories_author_user_id_fkey"
      columns: ["author_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stories_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stories_deleted_by_fkey"
      columns: ["deleted_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"story_views": {
                  Row: {
                    "story_id": string,"viewed_at": string,"viewer_user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "story_id": string,"viewed_at"?: string,"viewer_user_id": string
                  }
                  Update: {
                    "story_id"?: string,"viewed_at"?: string,"viewer_user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "story_views_story_id_fkey"
      columns: ["story_id"]
isOneToOne: false
      referencedRelation: "stories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "story_views_viewer_user_id_fkey"
      columns: ["viewer_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "admin_set_account_status":
{ Args: { "p_status": string,"p_user_id": string }; Returns: {
              "avatar_path": string | null,
"avatar_url": string | null,
"bio": string | null,
"created_at": string,
"display_name": string | null,
"first_name": string | null,
"id": string,
"last_name": string | null,
"status": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "profiles"
        isOneToOne: true
        isSetofReturn: false
      } },
"archive_notification":
{ Args: { "p_notification_id": string }; Returns: boolean
                           },
"cancel_rsvp":
{ Args: { "p_event_id": string }; Returns: boolean
                           },
"community_stats":
{ Args: { "p_community_id": string }; Returns: {
              "active_alerts": number,"current_announcements": number,"document_count": number,"member_count": number,"posts_today": number,"upcoming_events": number
            }[]
                           },
"complete_document_upload":
{ Args: { "p_document_id": string }; Returns: {
              "archived_at": string | null,
"community_id": string,
"created_at": string,
"deleted_at": string | null,
"file_extension": string,
"file_purged_at": string | null,
"file_size": number,
"folder_id": string | null,
"id": string,
"mime_type": string,
"name": string,
"status": string,
"storage_path": string | null,
"updated_at": string,
"updated_by_user_id": string | null,
"uploaded_at": string | null,
"uploaded_by": string | null,
"visibility": string
            }
                          SetofOptions: {
        from: "*"
        to: "documents"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_community":
{ Args: { "p_community_type"?: string,"p_description"?: string,"p_name": string,"p_slug": string,"p_timezone"?: string }; Returns: {
              "community_type": string,
"cover_image_path": string | null,
"cover_image_url": string | null,
"created_at": string,
"created_by": string | null,
"description": string | null,
"id": string,
"logo_path": string | null,
"logo_url": string | null,
"name": string,
"settings": NonNullable<Json>,
"slug": string,
"status": string,
"timezone": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "communities"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_document_upload":
{ Args: { "p_community_id": string,"p_file_size": number,"p_folder_id"?: string,"p_mime_type": string,"p_name": string,"p_visibility"?: string }; Returns: {
              "bucket_id": string,"document_id": string,"max_file_size_bytes": number,"storage_path": string
            }[]
                           },
"create_invitation":
{ Args: { "p_community_id": string,"p_expires_in"?: string,"p_max_uses"?: number }; Returns: {
              "expires_at": string,"invitation_id": string,"max_uses": number,"token": string
            }[]
                           },
"create_notification":
{ Args: { "p_body"?: string,"p_community_id": string,"p_data"?: Json,"p_dedupe_key"?: string,"p_title": string,"p_type": string,"p_user_id": string }; Returns: string
                           },
"create_post":
{ Args: { "p_body": string,"p_client_request_id"?: string,"p_community_id": string,"p_images"?: Json }; Returns: {
              "author_user_id": string | null,
"body": string,
"client_request_id": string | null,
"community_id": string,
"created_at": string,
"edited_at": string | null,
"id": string,
"moderated_at": string | null,
"moderated_by_user_id": string | null,
"moderation_reason": string | null,
"status": string,
"updated_at": string,
"visibility": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "posts"
        isOneToOne: false
        isSetofReturn: true
      } },
"create_story":
{ Args: { "p_caption"?: string,"p_client_request_id"?: string,"p_community_id": string,"p_height": number,"p_path": string,"p_width": number }; Returns: {
              "author_user_id": string,
"caption": string | null,
"client_request_id": string | null,
"community_id": string,
"created_at": string,
"deleted_at": string | null,
"deleted_by": string | null,
"expires_at": string,
"height": number,
"id": string,
"storage_path": string,
"width": number
            }[]
                          SetofOptions: {
        from: "*"
        to: "stories"
        isOneToOne: false
        isSetofReturn: true
      } },
"delete_my_account":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"delete_story":
{ Args: { "p_story_id": string }; Returns: boolean
                           },
"expire_due_alerts":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"expire_invitations":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"get_community_member":
{ Args: { "p_community_id": string,"p_user_id": string }; Returns: {
              "avatar_path": string,"avatar_url": string,"bio": string,"display_name": string,"first_name": string,"is_me": boolean,"joined_at": string,"last_name": string,"membership_id": string,"role_names": (string)[],"user_id": string
            }[]
                           },
"get_event_attendance":
{ Args: { "p_event_id": string }; Returns: {
              "capacity": number,"event_id": string,"going_count": number,"maybe_count": number,"my_status": string,"my_waitlist_position": number,"not_going_count": number,"spots_left": number,"waitlisted_count": number
            }[]
                           },
"get_reaction_summary":
{ Args: { "p_comment_ids"?: (string)[],"p_post_ids"?: (string)[] }; Returns: {
              "comment_id": string,"post_id": string,"reacted_by_me": boolean,"reaction_count": number,"reaction_type": string
            }[]
                           },
"has_community_permission":
{ Args: { "p_community_id": string,"p_permission_key": string }; Returns: boolean
                           },
"list_active_alerts":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_published_at"?: string,"p_cursor_severity_rank"?: number,"p_limit"?: number }; Returns: {
              "body": string,"community_id": string,"edited_at": string,"expires_at": string,"id": string,"is_emergency": boolean,"published_at": string,"published_by": string,"severity": string,"severity_rank": number,"title": string
            }[]
                           },
"list_alert_history":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_sort_at"?: string,"p_limit"?: number,"p_statuses"?: (string)[] }; Returns: {
              "archived_at": string,"body": string,"cancellation_reason": string,"cancelled_at": string,"community_id": string,"expired_at": string,"expires_at": string,"id": string,"is_active": boolean,"is_emergency": boolean,"published_at": string,"severity": string,"severity_rank": number,"sort_at": string,"status": string,"title": string
            }[]
                           },
"list_alert_image_files_to_purge":
{ Args: { "p_grace"?: string }; Returns: {
              "name": string
            }[]
                           },
"list_announcement_history":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_sort_at"?: string,"p_limit"?: number,"p_statuses"?: (string)[] }; Returns: {
              "archived_at": string,"author_user_id": string,"body": string,"community_id": string,"edited_at": string,"expires_at": string,"id": string,"is_expired": boolean,"priority": string,"published_at": string,"sort_at": string,"status": string,"title": string
            }[]
                           },
"list_audit_logs":
{ Args: { "p_action"?: string,"p_actor_user_id"?: string,"p_community_id": string,"p_cursor_created_at"?: string,"p_cursor_id"?: string,"p_entity_id"?: string,"p_entity_type"?: string,"p_limit"?: number }; Returns: {
              "action": string,
"actor_user_id": string | null,
"community_id": string | null,
"created_at": string,
"entity_id": string | null,
"entity_type": string,
"id": string,
"metadata": NonNullable<Json>
            }[]
                          SetofOptions: {
        from: "*"
        to: "audit_logs"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_avatar_files_to_purge":
{ Args: { "p_grace"?: string }; Returns: {
              "name": string
            }[]
                           },
"list_community_media_to_purge":
{ Args: { "p_grace"?: string }; Returns: {
              "name": string
            }[]
                           },
"list_community_members":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_name"?: string,"p_cursor_unnamed"?: boolean,"p_limit"?: number,"p_query"?: string }; Returns: {
              "avatar_path": string,"avatar_url": string,"display_name": string,"is_me": boolean,"joined_at": string,"membership_id": string,"role_names": (string)[],"sort_name": string,"sort_unnamed": boolean,"user_id": string
            }[]
                           },
"list_community_posts":
{ Args: { "p_community_id": string,"p_cursor_created_at"?: string,"p_cursor_id"?: string,"p_limit"?: number,"p_status"?: string }; Returns: {
              "author_avatar_url": string,"author_display_name": string,"author_user_id": string,"body": string,"comment_count": number,"community_id": string,"created_at": string,"edited_at": string,"id": string,"moderation_reason": string,"my_reaction_type": string,"reaction_count": number,"status": string,"updated_at": string,"visibility": string
            }[]
                           },
"list_community_stories":
{ Args: { "p_community_id": string }; Returns: {
              "author_display_name": string,"author_user_id": string,"caption": string,"community_id": string,"created_at": string,"expires_at": string,"height": number,"id": string,"storage_path": string,"view_count": number,"viewed_by_me": boolean,"width": number
            }[]
                           },
"list_current_announcements":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_priority"?: string,"p_cursor_published_at"?: string,"p_limit"?: number }; Returns: {
              "author_user_id": string,"body": string,"community_id": string,"edited_at": string,"expires_at": string,"id": string,"priority": string,"published_at": string,"status": string,"title": string
            }[]
                           },
"list_document_files_to_purge":
{ Args: { "p_retention"?: string }; Returns: {
              "document_id": string,"status": string,"storage_path": string
            }[]
                           },
"list_documents":
{ Args: { "p_community_id": string,"p_cursor_created_at"?: string,"p_cursor_id"?: string,"p_folder_id"?: string,"p_limit"?: number,"p_root_only"?: boolean,"p_statuses"?: (string)[] }; Returns: {
              "archived_at": string | null,
"community_id": string,
"created_at": string,
"deleted_at": string | null,
"file_extension": string,
"file_purged_at": string | null,
"file_size": number,
"folder_id": string | null,
"id": string,
"mime_type": string,
"name": string,
"status": string,
"storage_path": string | null,
"updated_at": string,
"updated_by_user_id": string | null,
"uploaded_at": string | null,
"uploaded_by": string | null,
"visibility": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "documents"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_events":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_starts_at"?: string,"p_from"?: string,"p_limit"?: number,"p_statuses"?: (string)[],"p_to"?: string }; Returns: {
              "cancellation_reason": string | null,
"cancelled_at": string | null,
"cancelled_by": string | null,
"capacity": number | null,
"community_id": string,
"completed_at": string | null,
"created_at": string,
"created_by": string | null,
"description": string | null,
"edited_at": string | null,
"ends_at": string,
"id": string,
"location_text": string | null,
"published_at": string | null,
"rsvp_changed_at": string | null,
"starts_at": string,
"status": string,
"timezone": string,
"title": string,
"updated_at": string,
"updated_by_user_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "events"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_invitations":
{ Args: { "p_community_id": string,"p_include_inactive"?: boolean }; Returns: {
              "community_id": string,"created_at": string,"created_by": string,"effective_status": string,"expires_at": string,"id": string,"max_uses": number,"revoked_at": string,"status": string,"use_count": number
            }[]
                           },
"list_listing_image_files_to_purge":
{ Args: { "p_grace"?: string }; Returns: {
              "name": string
            }[]
                           },
"list_my_active_alerts":
{ Args: Record<PropertyKey, never>; Returns: {
              "community_id": string,"expires_at": string,"id": string,"is_emergency": boolean,"published_at": string,"severity": string,"severity_rank": number,"title": string
            }[]
                           },
"list_my_notifications":
{ Args: { "p_community_id"?: string,"p_cursor_created_at"?: string,"p_cursor_id"?: string,"p_include_archived"?: boolean,"p_limit"?: number,"p_unread_only"?: boolean }; Returns: {
              "archived_at": string | null,
"body": string | null,
"community_id": string | null,
"created_at": string,
"data": NonNullable<Json>,
"dedupe_key": string | null,
"id": string,
"read_at": string | null,
"title": string,
"type": string,
"user_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "notifications"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_past_events":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_starts_at"?: string,"p_limit"?: number }; Returns: {
              "cancellation_reason": string | null,
"cancelled_at": string | null,
"cancelled_by": string | null,
"capacity": number | null,
"community_id": string,
"completed_at": string | null,
"created_at": string,
"created_by": string | null,
"description": string | null,
"edited_at": string | null,
"ends_at": string,
"id": string,
"location_text": string | null,
"published_at": string | null,
"rsvp_changed_at": string | null,
"starts_at": string,
"status": string,
"timezone": string,
"title": string,
"updated_at": string,
"updated_by_user_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "events"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_post_comments":
{ Args: { "p_cursor_created_at"?: string,"p_cursor_id"?: string,"p_limit"?: number,"p_parent_comment_id"?: string,"p_post_id": string }; Returns: {
              "author_avatar_url": string,"author_display_name": string,"author_user_id": string,"body": string,"created_at": string,"depth": number,"edited_at": string,"id": string,"my_reaction_type": string,"parent_comment_id": string,"post_id": string,"reaction_count": number,"reply_count": number,"status": string
            }[]
                           },
"list_post_image_files_to_purge":
{ Args: { "p_grace"?: string }; Returns: {
              "name": string
            }[]
                           },
"list_story_files_to_purge":
{ Args: { "p_grace"?: string }; Returns: {
              "name": string
            }[]
                           },
"list_upcoming_events":
{ Args: { "p_community_id": string,"p_cursor_id"?: string,"p_cursor_starts_at"?: string,"p_limit"?: number }; Returns: {
              "cancellation_reason": string | null,
"cancelled_at": string | null,
"cancelled_by": string | null,
"capacity": number | null,
"community_id": string,
"completed_at": string | null,
"created_at": string,
"created_by": string | null,
"description": string | null,
"edited_at": string | null,
"ends_at": string,
"id": string,
"location_text": string | null,
"published_at": string | null,
"rsvp_changed_at": string | null,
"starts_at": string,
"status": string,
"timezone": string,
"title": string,
"updated_at": string,
"updated_by_user_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "events"
        isOneToOne: false
        isSetofReturn: true
      } },
"mark_all_notifications_read":
{ Args: { "p_community_id"?: string }; Returns: number
                           },
"mark_notification_read":
{ Args: { "p_notification_id": string }; Returns: boolean
                           },
"mark_notification_unread":
{ Args: { "p_notification_id": string }; Returns: boolean
                           },
"mark_story_viewed":
{ Args: { "p_story_id": string }; Returns: boolean
                           },
"my_communities":
{ Args: Record<PropertyKey, never>; Returns: {
              "community_id": string,"community_status": string,"community_type": string,"joined_at": string,"logo_path": string,"logo_url": string,"membership_id": string,"membership_status": string,"name": string,"role_names": (string)[],"slug": string
            }[]
                           },
"my_community_notification_settings":
{ Args: { "p_community_id": string }; Returns: {
              "alerts": boolean,"announcements": boolean,"comments": boolean,"events": boolean
            }[]
                           },
"my_community_permissions":
{ Args: { "p_community_id": string }; Returns: string[]
                           },
"my_profile_stats":
{ Args: Record<PropertyKey, never>; Returns: {
              "communities": number,"events_going": number,"member_since": string,"posts": number
            }[]
                           },
"preview_invitation":
{ Args: { "p_token": string }; Returns: {
              "community_id": string,"community_type": string,"cover_image_path": string,"cover_image_url": string,"description": string,"expires_at": string,"logo_path": string,"logo_url": string,"member_count": number,"membership_status": string,"name": string
            }[]
                           },
"purge_audit_logs":
{ Args: { "p_older_than": string }; Returns: number
                           },
"purge_expired_stories":
{ Args: { "p_grace"?: string }; Returns: number
                           },
"purge_rate_limit_counters":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"record_system_audit_event":
{ Args: { "p_action": string,"p_community_id": string,"p_entity_id"?: string,"p_entity_type": string,"p_metadata"?: Json }; Returns: string
                           },
"redeem_invitation":
{ Args: { "p_token": string }; Returns: {
              "community_id": string,"membership_id": string,"membership_status": string
            }[]
                           },
"revoke_invitation":
{ Args: { "p_invitation_id": string }; Returns: boolean
                           },
"rsvp_to_event":
{ Args: { "p_event_id": string,"p_status": string }; Returns: {
              "event_id": string,"status": string,"waitlisted_at": string
            }[]
                           },
"search_listings":
{ Args: { "p_category_id"?: string,"p_community_id": string,"p_condition"?: string,"p_favorites_only"?: boolean,"p_in_stock_only"?: boolean,"p_kind"?: string,"p_limit"?: number,"p_max_price_minor"?: number,"p_min_price_minor"?: number,"p_offset"?: number,"p_query"?: string,"p_seller_profile_id"?: string,"p_sort"?: string }; Returns: {
              "available": number,"category_id": string,"category_name": string,"community_id": string,"condition": string,"cover_image_path": string,"currency": string,"id": string,"image_count": number,"is_favorite": boolean,"kind": string,"price_minor": number,"pricing": string,"published_at": string,"rank": number,"seller_display_name": string,"seller_profile_id": string,"seller_verified": boolean,"title": string
            }[]
                           },
"set_community_notification_settings":
{ Args: { "p_alerts"?: boolean,"p_announcements"?: boolean,"p_comments"?: boolean,"p_community_id": string,"p_events"?: boolean }; Returns: {
              "alerts": boolean,"announcements": boolean,"comments": boolean,"events": boolean
            }[]
                           },
"set_listing_stock":
{ Args: { "p_listing_id": string,"p_note"?: string,"p_on_hand": number }; Returns: {
              "available": number,"listing_id": string,"on_hand": number,"reserved": number
            }[]
                           },
"unread_notification_count":
{ Args: { "p_community_id"?: string }; Returns: number
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const

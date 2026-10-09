export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      block_cards: {
        Row: {
          address: string | null
          agent: string | null
          board_id: string
          bo: string | null
          canvass_stats: string | null
          card_date: string | null
          comments: string | null
          created_at: string
          group_title: string | null
          iss: string | null
          lat: number | null
          lead_name: string | null
          lng: number | null
          missing_from_report: boolean | null
          monday_item_id: string
          office_location: string
          ol: string | null
          phone: string | null
          pm: string | null
          products: string | null
          report_reps: string[] | null
          reps: string[]
          rs: string | null
          sale: string | null
          sale_price: number | null
          source: string | null
          updated_at: string
          wcc: string | null
        }
        Insert: {
          address?: string | null
          agent?: string | null
          board_id: string
          bo?: string | null
          canvass_stats?: string | null
          card_date?: string | null
          comments?: string | null
          created_at?: string
          group_title?: string | null
          iss?: string | null
          lat?: number | null
          lead_name?: string | null
          lng?: number | null
          missing_from_report?: boolean | null
          monday_item_id: string
          office_location?: string
          ol?: string | null
          phone?: string | null
          pm?: string | null
          products?: string | null
          report_reps?: string[] | null
          reps?: string[]
          rs?: string | null
          sale?: string | null
          sale_price?: number | null
          source?: string | null
          updated_at?: string
          wcc?: string | null
        }
        Update: {
          address?: string | null
          agent?: string | null
          board_id?: string
          bo?: string | null
          canvass_stats?: string | null
          card_date?: string | null
          comments?: string | null
          created_at?: string
          group_title?: string | null
          iss?: string | null
          lat?: number | null
          lead_name?: string | null
          lng?: number | null
          missing_from_report?: boolean | null
          monday_item_id?: string
          office_location?: string
          ol?: string | null
          phone?: string | null
          pm?: string | null
          products?: string | null
          report_reps?: string[] | null
          reps?: string[]
          rs?: string | null
          sale?: string | null
          sale_price?: number | null
          source?: string | null
          updated_at?: string
          wcc?: string | null
        }
        Relationships: []
      }
      contest_bounties: {
        Row: {
          active: boolean
          categories: string[]
          created_at: string
          created_by: string | null
          ends_on: string
          id: string
          label: string
          multiplier: number
          starts_on: string
        }
        Insert: {
          active?: boolean
          categories?: string[]
          created_at?: string
          created_by?: string | null
          ends_on: string
          id?: string
          label: string
          multiplier?: number
          starts_on: string
        }
        Update: {
          active?: boolean
          categories?: string[]
          created_at?: string
          created_by?: string | null
          ends_on?: string
          id?: string
          label?: string
          multiplier?: number
          starts_on?: string
        }
        Relationships: []
      }
      contest_ledger: {
        Row: {
          category: string
          created_at: string
          id: string
          locked_at: string | null
          meta: Json
          month: string
          occurred_on: string | null
          points: number
          rep_name: string
          source_id: string
          source_kind: string
          status: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          locked_at?: string | null
          meta?: Json
          month: string
          occurred_on?: string | null
          points: number
          rep_name: string
          source_id: string
          source_kind: string
          status: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          locked_at?: string | null
          meta?: Json
          month?: string
          occurred_on?: string | null
          points?: number
          rep_name?: string
          source_id?: string
          source_kind?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      contest_proofs: {
        Row: {
          category: string
          created_at: string
          customer_name: string | null
          deny_reason: string | null
          id: string
          link_url: string | null
          note: string
          points_awarded: number | null
          rep_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          sat_on: string | null
          status: string
          storage_path: string | null
        }
        Insert: {
          category: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          link_url?: string | null
          note: string
          points_awarded?: number | null
          rep_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sat_on?: string | null
          status?: string
          storage_path?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          link_url?: string | null
          note?: string
          points_awarded?: number | null
          rep_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sat_on?: string | null
          status?: string
          storage_path?: string | null
        }
        Relationships: []
      }
      contest_rules: {
        Row: {
          id: boolean
          rules: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: boolean
          rules?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: boolean
          rules?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      kombat_rep_aliases: {
        Row: {
          board_name: string
          created_at: string
          created_by: string | null
          note: string | null
          profile_id: string
          updated_at: string
        }
        Insert: {
          board_name: string
          created_at?: string
          created_by?: string | null
          note?: string | null
          profile_id: string
          updated_at?: string
        }
        Update: {
          board_name?: string
          created_at?: string
          created_by?: string | null
          note?: string | null
          profile_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      customer_homes_legacy: {
        Row: {
          address: string | null
          board_name: string | null
          created_at: string
          customer_name: string | null
          lat: number | null
          lng: number | null
          monday_item_id: string
          office_location: string
          products: string | null
          sale: string | null
          sold_on: string | null
        }
        Insert: {
          address?: string | null
          board_name?: string | null
          created_at?: string
          customer_name?: string | null
          lat?: number | null
          lng?: number | null
          monday_item_id: string
          office_location?: string
          products?: string | null
          sale?: string | null
          sold_on?: string | null
        }
        Update: {
          address?: string | null
          board_name?: string | null
          created_at?: string
          customer_name?: string | null
          lat?: number | null
          lng?: number | null
          monday_item_id?: string
          office_location?: string
          products?: string | null
          sale?: string | null
          sold_on?: string | null
        }
        Relationships: []
      }
      canvasser_stats: {
        Row: {
          contacts_made: number
          created_at: string
          doors_knocked: number
          id: string
          period: string
          period_start: string
          revenue_generated: number
          sales_closed: number
          user_id: string
        }
        Insert: {
          contacts_made?: number
          created_at?: string
          doors_knocked?: number
          id?: string
          period: string
          period_start: string
          revenue_generated?: number
          sales_closed?: number
          user_id: string
        }
        Update: {
          contacts_made?: number
          created_at?: string
          doors_knocked?: number
          id?: string
          period?: string
          period_start?: string
          revenue_generated?: number
          sales_closed?: number
          user_id?: string
        }
        Relationships: []
      }
      company_settings: {
        Row: {
          company_name: string
          global_visibility: boolean
          id: boolean
          objections_quickpick_enabled: boolean
          updated_at: string
        }
        Insert: {
          company_name?: string
          global_visibility?: boolean
          id?: boolean
          objections_quickpick_enabled?: boolean
          updated_at?: string
        }
        Update: {
          company_name?: string
          global_visibility?: boolean
          id?: boolean
          objections_quickpick_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      daily_logs: {
        Row: {
          canvasser_id: string
          confirmed_leads: number
          created_at: string
          ctc: number
          demos_sits: number
          doors_knocked: number
          future_leads: number
          id: string
          leads_called_in: number
          log_date: string
          next_days: number
          no_demo: number
          no_shows: number
          non_core: number
          not_home: number
          not_interested: number
          notes: string | null
          office_location: string
          one_legs: number
          people_talked_to: number
          renters: number
          sales: number
          team_id: string | null
          unmarked: number
          updated_at: string
        }
        Insert: {
          canvasser_id: string
          confirmed_leads?: number
          created_at?: string
          ctc?: number
          demos_sits?: number
          doors_knocked?: number
          future_leads?: number
          id?: string
          leads_called_in?: number
          log_date?: string
          next_days?: number
          no_demo?: number
          no_shows?: number
          non_core?: number
          not_home?: number
          not_interested?: number
          notes?: string | null
          office_location?: string
          one_legs?: number
          people_talked_to?: number
          renters?: number
          sales?: number
          team_id?: string | null
          unmarked?: number
          updated_at?: string
        }
        Update: {
          canvasser_id?: string
          confirmed_leads?: number
          created_at?: string
          ctc?: number
          demos_sits?: number
          doors_knocked?: number
          future_leads?: number
          id?: string
          leads_called_in?: number
          log_date?: string
          next_days?: number
          no_demo?: number
          no_shows?: number
          non_core?: number
          not_home?: number
          not_interested?: number
          notes?: string | null
          office_location?: string
          one_legs?: number
          people_talked_to?: number
          renters?: number
          sales?: number
          team_id?: string | null
          unmarked?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_metrics: {
        Row: {
          blowouts: number
          canvasser_id: string
          created_at: string
          future: number
          id: string
          killed: number
          leads_called_in: number
          leads_confirmed: number
          leads_generated: number
          leads_submitted: number
          metric_date: string
          no_answers: number
          office_location: string
          outside_leads: number
          pending: number
          pitch_missed: number
          resets: number
          sales: number
          sits_ran_today: number
          team_id: string | null
          updated_at: string
        }
        Insert: {
          blowouts?: number
          canvasser_id: string
          created_at?: string
          future?: number
          id?: string
          killed?: number
          leads_called_in?: number
          leads_confirmed?: number
          leads_generated?: number
          leads_submitted?: number
          metric_date?: string
          no_answers?: number
          office_location?: string
          outside_leads?: number
          pending?: number
          pitch_missed?: number
          resets?: number
          sales?: number
          sits_ran_today?: number
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          blowouts?: number
          canvasser_id?: string
          created_at?: string
          future?: number
          id?: string
          killed?: number
          leads_called_in?: number
          leads_confirmed?: number
          leads_generated?: number
          leads_submitted?: number
          metric_date?: string
          no_answers?: number
          office_location?: string
          outside_leads?: number
          pending?: number
          pitch_missed?: number
          resets?: number
          sales?: number
          sits_ran_today?: number
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_metrics_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_metrics_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      field_pins: {
        Row: {
          canvasser_id: string
          created_at: string
          device_lat: number | null
          device_lng: number | null
          distance_m: number | null
          id: string
          is_remote_drop: boolean
          lat: number
          lng: number
          log_date: string
          note: string | null
          objection: string | null
          pin_type: Database["public"]["Enums"]["pin_type"]
        }
        Insert: {
          canvasser_id: string
          created_at?: string
          device_lat?: number | null
          device_lng?: number | null
          distance_m?: number | null
          id?: string
          is_remote_drop?: boolean
          lat: number
          lng: number
          log_date?: string
          note?: string | null
          objection?: string | null
          pin_type: Database["public"]["Enums"]["pin_type"]
        }
        Update: {
          canvasser_id?: string
          created_at?: string
          device_lat?: number | null
          device_lng?: number | null
          distance_m?: number | null
          id?: string
          is_remote_drop?: boolean
          lat?: number
          lng?: number
          log_date?: string
          note?: string | null
          objection?: string | null
          pin_type?: Database["public"]["Enums"]["pin_type"]
        }
        Relationships: [
          {
            foreignKeyName: "field_pins_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hype_events: {
        Row: {
          canvasser_id: string | null
          canvasser_name: string | null
          created_at: string
          id: string
          kind: string
          message: string
          payload: Json
        }
        Insert: {
          canvasser_id?: string | null
          canvasser_name?: string | null
          created_at?: string
          id?: string
          kind: string
          message: string
          payload?: Json
        }
        Update: {
          canvasser_id?: string | null
          canvasser_name?: string | null
          created_at?: string
          id?: string
          kind?: string
          message?: string
          payload?: Json
        }
        Relationships: []
      }
      lead_events: {
        Row: {
          canvasser_id: string | null
          count: number
          created_at: string
          id: string
          occurred_at: string
          team_id: string
        }
        Insert: {
          canvasser_id?: string | null
          count?: number
          created_at?: string
          id?: string
          occurred_at?: string
          team_id: string
        }
        Update: {
          canvasser_id?: string | null
          count?: number
          created_at?: string
          id?: string
          occurred_at?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          address: string | null
          canvasser_id: string
          created_at: string
          customer_name: string | null
          deny_reason: string | null
          id: string
          is_sale: boolean
          monday_item_id: string | null
          notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sale_amount: number | null
          sale_cancelled_at: string | null
          status: Database["public"]["Enums"]["lead_status"]
          team_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          canvasser_id: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          is_sale?: boolean
          monday_item_id?: string | null
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_amount?: number | null
          sale_cancelled_at?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          canvasser_id?: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          is_sale?: boolean
          monday_item_id?: string | null
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_amount?: number | null
          sale_cancelled_at?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      offices: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          avg_commission: number
          consecutive_weeks_3_plus_sits: number
          consecutive_weeks_7_plus_sits: number
          created_at: string
          current_rank: string | null
          display_name: string
          id: string
          is_active: boolean
          is_placeholder: boolean
          suspension_tracked: boolean
          level: number
          monthly_goal: number
          office_location: string
          pay_lock_evaluated_week: string | null
          pay_lock_prev_reverted_on: string | null
          pay_lock_prev_status: string | null
          pay_lock_prev_warned_on: string | null
          pay_lock_reverted_on: string | null
          pay_lock_status: string
          pay_lock_warned_on: string | null
          recruits_count: number
          rolling_4_week_sit_avg: number
          status: Database["public"]["Enums"]["canvasser_status"]
          team_id: string | null
          updated_at: string
          van_locked_at: string | null
          van_locked_by: string | null
          weekly_income_goal: number
          weekly_volume_goal: number | null
          xp: number
        }
        Insert: {
          avatar_url?: string | null
          avg_commission?: number
          consecutive_weeks_3_plus_sits?: number
          consecutive_weeks_7_plus_sits?: number
          created_at?: string
          current_rank?: string | null
          display_name: string
          id: string
          is_active?: boolean
          is_placeholder?: boolean
          suspension_tracked?: boolean
          level?: number
          monthly_goal?: number
          office_location?: string
          pay_lock_evaluated_week?: string | null
          pay_lock_prev_reverted_on?: string | null
          pay_lock_prev_status?: string | null
          pay_lock_prev_warned_on?: string | null
          pay_lock_reverted_on?: string | null
          pay_lock_status?: string
          pay_lock_warned_on?: string | null
          recruits_count?: number
          rolling_4_week_sit_avg?: number
          status?: Database["public"]["Enums"]["canvasser_status"]
          team_id?: string | null
          updated_at?: string
          van_locked_at?: string | null
          van_locked_by?: string | null
          weekly_income_goal?: number
          weekly_volume_goal?: number | null
          xp?: number
        }
        Update: {
          avatar_url?: string | null
          avg_commission?: number
          consecutive_weeks_3_plus_sits?: number
          consecutive_weeks_7_plus_sits?: number
          created_at?: string
          current_rank?: string | null
          display_name?: string
          id?: string
          is_active?: boolean
          is_placeholder?: boolean
          suspension_tracked?: boolean
          level?: number
          monthly_goal?: number
          office_location?: string
          pay_lock_evaluated_week?: string | null
          pay_lock_prev_reverted_on?: string | null
          pay_lock_prev_status?: string | null
          pay_lock_prev_warned_on?: string | null
          pay_lock_reverted_on?: string | null
          pay_lock_status?: string
          pay_lock_warned_on?: string | null
          recruits_count?: number
          rolling_4_week_sit_avg?: number
          status?: Database["public"]["Enums"]["canvasser_status"]
          team_id?: string | null
          updated_at?: string
          van_locked_at?: string | null
          van_locked_by?: string | null
          weekly_income_goal?: number
          weekly_volume_goal?: number | null
          xp?: number
        }
        Relationships: [
          {
            foreignKeyName: "profiles_team_fk"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_commission_notes: {
        Row: {
          actual_amount: number | null
          created_at: string
          estimated_amount: number | null
          id: string
          monday_item_id: string
          next_payroll: boolean
          paid_at: string | null
          rep_id: string
          updated_at: string
        }
        Insert: {
          actual_amount?: number | null
          created_at?: string
          estimated_amount?: number | null
          id?: string
          monday_item_id: string
          next_payroll?: boolean
          paid_at?: string | null
          rep_id: string
          updated_at?: string
        }
        Update: {
          actual_amount?: number | null
          created_at?: string
          estimated_amount?: number | null
          id?: string
          monday_item_id?: string
          next_payroll?: boolean
          paid_at?: string | null
          rep_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_commission_notes_rep_id_fkey"
            columns: ["rep_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      repcard_canvasser_results: {
        Row: {
          active: boolean
          appts_set: number
          avg_distance_mi: number | null
          avg_doors_per_day: number | null
          close_ratio_pct: number | null
          door_knocked_days: number
          doors_knocked: number
          first_door_knock: string | null
          id: string
          imported_at: string
          last_door_knock: string | null
          office: string | null
          period_end: string
          period_start: string
          rep_name: string
          repcard_user_id: number | null
          source: string
          talk_ratio_pct: number | null
          talked_to: number
          team: string | null
          time_in_field_hours: number | null
          verified_door_knock: number
        }
        Insert: {
          active?: boolean
          appts_set?: number
          avg_distance_mi?: number | null
          avg_doors_per_day?: number | null
          close_ratio_pct?: number | null
          door_knocked_days?: number
          doors_knocked?: number
          first_door_knock?: string | null
          id?: string
          imported_at?: string
          last_door_knock?: string | null
          office?: string | null
          period_end: string
          period_start: string
          rep_name: string
          repcard_user_id?: number | null
          source?: string
          talk_ratio_pct?: number | null
          talked_to?: number
          team?: string | null
          time_in_field_hours?: number | null
          verified_door_knock?: number
        }
        Update: {
          active?: boolean
          appts_set?: number
          avg_distance_mi?: number | null
          avg_doors_per_day?: number | null
          close_ratio_pct?: number | null
          door_knocked_days?: number
          doors_knocked?: number
          first_door_knock?: string | null
          id?: string
          imported_at?: string
          last_door_knock?: string | null
          office?: string | null
          period_end?: string
          period_start?: string
          rep_name?: string
          repcard_user_id?: number | null
          source?: string
          talk_ratio_pct?: number | null
          talked_to?: number
          team?: string | null
          time_in_field_hours?: number | null
          verified_door_knock?: number
        }
        Relationships: []
      }
      repcard_territory_history: {
        Row: {
          assigned_at: string | null
          assigned_by_name: string | null
          color: string | null
          id: string
          imported_at: string
          office: string | null
          polygon_coordinates: Json
          rep_name: string | null
          repcard_area_id: number | null
          repcard_user_id: number | null
          source: string
          team: string | null
        }
        Insert: {
          assigned_at?: string | null
          assigned_by_name?: string | null
          color?: string | null
          id?: string
          imported_at?: string
          office?: string | null
          polygon_coordinates: Json
          rep_name?: string | null
          repcard_area_id?: number | null
          repcard_user_id?: number | null
          source?: string
          team?: string | null
        }
        Update: {
          assigned_at?: string | null
          assigned_by_name?: string | null
          color?: string | null
          id?: string
          imported_at?: string
          office?: string | null
          polygon_coordinates?: Json
          rep_name?: string | null
          repcard_area_id?: number | null
          repcard_user_id?: number | null
          source?: string
          team?: string | null
        }
        Relationships: []
      }
      company_costs: {
        Row: {
          cogs_pct: number | null
          month: string
          office: string
          office_payroll: number | null
          updated_at: string
        }
        Insert: {
          cogs_pct?: number | null
          month: string
          office: string
          office_payroll?: number | null
          updated_at?: string
        }
        Update: {
          cogs_pct?: number | null
          month?: string
          office?: string
          office_payroll?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      company_targets: {
        Row: {
          annual_goal: number
          id: boolean
          monthly_collected_target: number
          oc_target: number | null
          sd_target: number | null
          updated_at: string
        }
        Insert: {
          annual_goal?: number
          id?: boolean
          monthly_collected_target?: number
          oc_target?: number | null
          sd_target?: number | null
          updated_at?: string
        }
        Update: {
          annual_goal?: number
          id?: boolean
          monthly_collected_target?: number
          oc_target?: number | null
          sd_target?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      geocode_cache: {
        Row: {
          address_norm: string
          created_at: string
          lat: number | null
          lng: number | null
        }
        Insert: {
          address_norm: string
          created_at?: string
          lat?: number | null
          lng?: number | null
        }
        Update: {
          address_norm?: string
          created_at?: string
          lat?: number | null
          lng?: number | null
        }
        Relationships: []
      }
      plan_pm_alert_log: {
        Row: {
          alerted_at: string
          monday_item_id: string
          status_note_date: string
        }
        Insert: {
          alerted_at?: string
          monday_item_id: string
          status_note_date: string
        }
        Update: {
          alerted_at?: string
          monday_item_id?: string
          status_note_date?: string
        }
        Relationships: []
      }
      production_job_notes: {
        Row: {
          monday_item_id: string
          notes_digest: Json
          updated_at: string
        }
        Insert: {
          monday_item_id: string
          notes_digest?: Json
          updated_at?: string
        }
        Update: {
          monday_item_id?: string
          notes_digest?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_job_notes_monday_item_id_fkey"
            columns: ["monday_item_id"]
            isOneToOne: true
            referencedRelation: "production_jobs"
            referencedColumns: ["monday_item_id"]
          },
        ]
      }
      production_job_overrides: {
        Row: {
          based_on_note_date: string | null
          homeowner_status: string
          monday_item_id: string
          note: string | null
          set_at: string
          set_by: string
        }
        Insert: {
          based_on_note_date?: string | null
          homeowner_status: string
          monday_item_id: string
          note?: string | null
          set_at?: string
          set_by: string
        }
        Update: {
          based_on_note_date?: string | null
          homeowner_status?: string
          monday_item_id?: string
          note?: string | null
          set_at?: string
          set_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_job_overrides_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      production_jobs: {
        Row: {
          address: string | null
          advantage_plus: boolean
          board_id: string
          completion_date: string | null
          created_at: string
          delayed_until: string | null
          geo_source: string | null
          group_id: string
          group_title: string
          homeowner_name: string | null
          homeowner_status: string
          homeowner_status_note_date: string | null
          homeowner_status_reason: string | null
          lat: number | null
          lng: number | null
          monday_item_id: string
          office_location: string | null
          pm_monday_ids: number[]
          pm_name: string | null
          prev_schedule_end: string | null
          prev_schedule_start: string | null
          projects: string | null
          referral_status: string | null
          reloaded: string | null
          reloads: string | null
          rep_monday_ids: number[]
          reps: string[]
          reviews_status: string | null
          sale_amount: number
          schedule_end: string | null
          schedule_start: string | null
          status_label: string | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          address?: string | null
          advantage_plus?: boolean
          board_id: string
          completion_date?: string | null
          created_at?: string
          delayed_until?: string | null
          geo_source?: string | null
          group_id: string
          group_title: string
          homeowner_name?: string | null
          homeowner_status?: string
          homeowner_status_note_date?: string | null
          homeowner_status_reason?: string | null
          lat?: number | null
          lng?: number | null
          monday_item_id: string
          office_location?: string | null
          pm_monday_ids?: number[]
          pm_name?: string | null
          prev_schedule_end?: string | null
          prev_schedule_start?: string | null
          projects?: string | null
          referral_status?: string | null
          reloaded?: string | null
          reloads?: string | null
          rep_monday_ids?: number[]
          reps?: string[]
          reviews_status?: string | null
          sale_amount?: number
          schedule_end?: string | null
          schedule_start?: string | null
          status_label?: string | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          address?: string | null
          advantage_plus?: boolean
          board_id?: string
          completion_date?: string | null
          created_at?: string
          delayed_until?: string | null
          geo_source?: string | null
          group_id?: string
          group_title?: string
          homeowner_name?: string | null
          homeowner_status?: string
          homeowner_status_note_date?: string | null
          homeowner_status_reason?: string | null
          lat?: number | null
          lng?: number | null
          monday_item_id?: string
          office_location?: string | null
          pm_monday_ids?: number[]
          pm_name?: string | null
          prev_schedule_end?: string | null
          prev_schedule_start?: string | null
          projects?: string | null
          referral_status?: string | null
          reloaded?: string | null
          reloads?: string | null
          rep_monday_ids?: number[]
          reps?: string[]
          reviews_status?: string | null
          sale_amount?: number
          schedule_end?: string | null
          schedule_start?: string | null
          status_label?: string | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: []
      }
      rep_job_visits: {
        Row: {
          created_at: string
          id: string
          monday_item_id: string
          rep_id: string
          visited_on: string
        }
        Insert: {
          created_at?: string
          id?: string
          monday_item_id: string
          rep_id: string
          visited_on: string
        }
        Update: {
          created_at?: string
          id?: string
          monday_item_id?: string
          rep_id?: string
          visited_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_job_visits_rep_id_fkey"
            columns: ["rep_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      canvasser_photos: {
        Row: {
          cartoon_full_url: string | null
          cartoon_meta: Json | null
          cartoon_portrait_url: string | null
          cartoon_prompt: string | null
          cartoon_status: string
          name: string
          name_norm: string
          photo_path: string | null
          profile_id: string
          source_hash: string | null
          updated_at: string
        }
        Insert: {
          cartoon_full_url?: string | null
          cartoon_meta?: Json | null
          cartoon_portrait_url?: string | null
          cartoon_prompt?: string | null
          cartoon_status?: string
          name: string
          name_norm: string
          photo_path?: string | null
          profile_id: string
          source_hash?: string | null
          updated_at?: string
        }
        Update: {
          cartoon_full_url?: string | null
          cartoon_meta?: Json | null
          cartoon_portrait_url?: string | null
          cartoon_prompt?: string | null
          cartoon_status?: string
          name?: string
          name_norm?: string
          photo_path?: string | null
          profile_id?: string
          source_hash?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rep_photos: {
        Row: {
          cartoon_full_url: string | null
          cartoon_meta: Json | null
          cartoon_portrait_url: string | null
          cartoon_prompt: string | null
          cartoon_status: string
          monday_user_id: number
          name: string
          name_norm: string
          photo_url: string | null
          source_hash: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          cartoon_full_url?: string | null
          cartoon_meta?: Json | null
          cartoon_portrait_url?: string | null
          cartoon_prompt?: string | null
          cartoon_status?: string
          monday_user_id: number
          name: string
          name_norm: string
          photo_url?: string | null
          source_hash?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          cartoon_full_url?: string | null
          cartoon_meta?: Json | null
          cartoon_portrait_url?: string | null
          cartoon_prompt?: string | null
          cartoon_status?: string
          monday_user_id?: number
          name?: string
          name_norm?: string
          photo_url?: string | null
          source_hash?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      report_collections: {
        Row: {
          actual_amount: number
          anticipated_date: string | null
          board_id: string
          board_name: string
          collected_date: string | null
          collection_month: string
          created_at: string
          customer_name: string | null
          date_deposited: string | null
          group_title: string | null
          in_bank: string | null
          milestone: string | null
          monday_item_id: string
          notes: string | null
          office: string | null
          payment_type: string | null
          planned_amount: number
          status: string | null
          updated_at: string
        }
        Insert: {
          actual_amount?: number
          anticipated_date?: string | null
          board_id: string
          board_name: string
          collected_date?: string | null
          collection_month: string
          created_at?: string
          customer_name?: string | null
          date_deposited?: string | null
          group_title?: string | null
          in_bank?: string | null
          milestone?: string | null
          monday_item_id: string
          notes?: string | null
          office?: string | null
          payment_type?: string | null
          planned_amount?: number
          status?: string | null
          updated_at?: string
        }
        Update: {
          actual_amount?: number
          anticipated_date?: string | null
          board_id?: string
          board_name?: string
          collected_date?: string | null
          collection_month?: string
          created_at?: string
          customer_name?: string | null
          date_deposited?: string | null
          group_title?: string | null
          in_bank?: string | null
          milestone?: string | null
          monday_item_id?: string
          notes?: string | null
          office?: string | null
          payment_type?: string | null
          planned_amount?: number
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      report_sale_reloads: {
        Row: {
          board_id: string
          board_name: string
          created_at: string
          date_went: string | null
          due_date: string | null
          name: string | null
          parent_item_id: string
          report_month: string
          reps: string[]
          result: string | null
          subitem_id: string
          updated_at: string
        }
        Insert: {
          board_id: string
          board_name: string
          created_at?: string
          date_went?: string | null
          due_date?: string | null
          name?: string | null
          parent_item_id: string
          report_month: string
          reps?: string[]
          result?: string | null
          subitem_id: string
          updated_at?: string
        }
        Update: {
          board_id?: string
          board_name?: string
          created_at?: string
          date_went?: string | null
          due_date?: string | null
          name?: string | null
          parent_item_id?: string
          report_month?: string
          reps?: string[]
          result?: string | null
          subitem_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      report_sales: {
        Row: {
          advantage_plus: string | null
          board_id: string
          board_name: string
          cancel_amt: number
          created_at: string
          customer_name: string | null
          date_sold: string | null
          marketing_home: string | null
          monday_item_id: string
          office: string | null
          phone: string | null
          report_month: string
          reps: string[]
          sale_amt: number
          sales_count: string | null
          source: string | null
          updated_at: string
          wcc: string | null
        }
        Insert: {
          advantage_plus?: string | null
          board_id: string
          board_name: string
          cancel_amt?: number
          created_at?: string
          customer_name?: string | null
          date_sold?: string | null
          marketing_home?: string | null
          monday_item_id: string
          office?: string | null
          phone?: string | null
          report_month: string
          reps?: string[]
          sale_amt?: number
          sales_count?: string | null
          source?: string | null
          updated_at?: string
          wcc?: string | null
        }
        Update: {
          advantage_plus?: string | null
          board_id?: string
          board_name?: string
          cancel_amt?: number
          created_at?: string
          customer_name?: string | null
          date_sold?: string | null
          marketing_home?: string | null
          monday_item_id?: string
          office?: string | null
          phone?: string | null
          report_month?: string
          reps?: string[]
          sale_amt?: number
          sales_count?: string | null
          source?: string | null
          updated_at?: string
          wcc?: string | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          active_monday_board_oc: string | null
          incoming_leads_board_id: string | null
          active_monday_board_sd: string | null
          created_at: string
          id: boolean
          live_dispatch_mode: string
          monday_api_token: string | null
          monday_template_board_id: string | null
          monday_webhooks: Json
          ooh_autocreate: boolean
          ooh_form_url: string | null
          ooh_go_live_at: string | null
          ooh_writeback_board_allowlist: string | null
          ooh_writeback_mode: string
          profile_photo_remind_later: boolean
          updated_at: string
        }
        Insert: {
          active_monday_board_oc?: string | null
          incoming_leads_board_id?: string | null
          active_monday_board_sd?: string | null
          created_at?: string
          id?: boolean
          live_dispatch_mode?: string
          monday_api_token?: string | null
          monday_template_board_id?: string | null
          monday_webhooks?: Json
          ooh_autocreate?: boolean
          ooh_form_url?: string | null
          ooh_go_live_at?: string | null
          ooh_writeback_board_allowlist?: string | null
          ooh_writeback_mode?: string
          profile_photo_remind_later?: boolean
          updated_at?: string
        }
        Update: {
          active_monday_board_oc?: string | null
          incoming_leads_board_id?: string | null
          active_monday_board_sd?: string | null
          created_at?: string
          id?: boolean
          live_dispatch_mode?: string
          monday_api_token?: string | null
          monday_template_board_id?: string | null
          monday_webhooks?: Json
          ooh_autocreate?: boolean
          ooh_form_url?: string | null
          ooh_go_live_at?: string | null
          ooh_writeback_board_allowlist?: string | null
          ooh_writeback_mode?: string
          profile_photo_remind_later?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      teams: {
        Row: {
          captain_id: string | null
          color: string
          created_at: string
          id: string
          name: string
          office_id: string | null
          office_location: string
        }
        Insert: {
          captain_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name: string
          office_id?: string | null
          office_location?: string
        }
        Update: {
          captain_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name?: string
          office_id?: string | null
          office_location?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "offices"
            referencedColumns: ["id"]
          },
        ]
      }
      territories: {
        Row: {
          canvasser_id: string | null
          color: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          polygon: Json
          team_id: string | null
          updated_at: string
        }
        Insert: {
          canvasser_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          polygon: Json
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          canvasser_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          polygon?: Json
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "territories_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "territories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "territories_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_periods: {
        Row: {
          created_at: string
          id: string
          meal_end: string | null
          meal_start: string
          time_entry_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          meal_end?: string | null
          meal_start?: string
          time_entry_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          meal_end?: string | null
          meal_start?: string
          time_entry_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meal_periods_time_entry_id_fkey"
            columns: ["time_entry_id"]
            isOneToOne: false
            referencedRelation: "time_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_clawbacks: {
        Row: {
          amount: number
          canvasser_id: string
          created_at: string
          id: string
          kind: string
          lead_id: string
          line_id: string
          run_id: string
          source_run_id: string | null
        }
        Insert: {
          amount: number
          canvasser_id: string
          created_at?: string
          id?: string
          kind: string
          lead_id: string
          line_id: string
          run_id: string
          source_run_id?: string | null
        }
        Update: {
          amount?: number
          canvasser_id?: string
          created_at?: string
          id?: string
          kind?: string
          lead_id?: string
          line_id?: string
          run_id?: string
          source_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commission_clawbacks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_clawbacks_line_id_fkey"
            columns: ["line_id"]
            isOneToOne: false
            referencedRelation: "payroll_run_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_clawbacks_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "payroll_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_clawbacks_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "payroll_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_run_lines: {
        Row: {
          base_pay: number
          canvasser_id: string
          commission: number
          commission_adjustment: number
          display_name: string
          dt_hours: number
          exceptions: Json
          hourly_rate: number
          hours: number
          id: string
          meal_premium_count: number
          meal_premium_pay: number
          monster_bonus: number
          ot_hours: number
          ot_premium_pay: number
          rank: string | null
          reg_hours: number
          regular_rate: number
          run_id: string
          sit_bonus: number
          snapshot: Json
          total_pay: number
        }
        Insert: {
          base_pay?: number
          canvasser_id: string
          commission?: number
          commission_adjustment?: number
          display_name: string
          dt_hours?: number
          exceptions?: Json
          hourly_rate?: number
          hours?: number
          id?: string
          meal_premium_count?: number
          meal_premium_pay?: number
          monster_bonus?: number
          ot_hours?: number
          ot_premium_pay?: number
          rank?: string | null
          reg_hours?: number
          regular_rate?: number
          run_id: string
          sit_bonus?: number
          snapshot?: Json
          total_pay?: number
        }
        Update: {
          base_pay?: number
          canvasser_id?: string
          commission?: number
          commission_adjustment?: number
          display_name?: string
          dt_hours?: number
          exceptions?: Json
          hourly_rate?: number
          hours?: number
          id?: string
          meal_premium_count?: number
          meal_premium_pay?: number
          monster_bonus?: number
          ot_hours?: number
          ot_premium_pay?: number
          rank?: string | null
          reg_hours?: number
          regular_rate?: number
          run_id?: string
          sit_bonus?: number
          snapshot?: Json
          total_pay?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_run_lines_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "payroll_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          updated_at: string
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          updated_at?: string
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      payroll_runs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string
          id: string
          notes: string | null
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          status: string
          week_start: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by: string
          id?: string
          notes?: string | null
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: string
          week_start: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: string
          week_start?: string
        }
        Relationships: []
      }
      time_clock_exceptions: {
        Row: {
          created_at: string
          early_from: string | null
          exception_date: string
          granted_by: string
          id: string
          late_until: string | null
          reason: string
          revoked_at: string | null
          revoked_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          early_from?: string | null
          exception_date: string
          granted_by: string
          id?: string
          late_until?: string | null
          reason: string
          revoked_at?: string | null
          revoked_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          early_from?: string | null
          exception_date?: string
          granted_by?: string
          id?: string
          late_until?: string | null
          reason?: string
          revoked_at?: string | null
          revoked_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      time_entries: {
        Row: {
          billable_hours: number
          clock_in: string
          clock_out: string | null
          created_at: string
          entry_source: string
          flag_reasons: string[]
          id: string
          log_date: string
          meal_status: string
          needs_correction: boolean
          reviewed_at: string | null
          reviewed_by: string | null
          second_meal_status: string
          updated_at: string
          user_id: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          billable_hours?: number
          clock_in?: string
          clock_out?: string | null
          created_at?: string
          entry_source?: string
          flag_reasons?: string[]
          id?: string
          log_date?: string
          meal_status?: string
          needs_correction?: boolean
          reviewed_at?: string | null
          reviewed_by?: string | null
          second_meal_status?: string
          updated_at?: string
          user_id: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          billable_hours?: number
          clock_in?: string
          clock_out?: string | null
          created_at?: string
          entry_source?: string
          flag_reasons?: string[]
          id?: string
          log_date?: string
          meal_status?: string
          needs_correction?: boolean
          reviewed_at?: string | null
          reviewed_by?: string | null
          second_meal_status?: string
          updated_at?: string
          user_id?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: []
      }
      time_entry_audit: {
        Row: {
          action: string
          actor: string | null
          happened_at: string
          id: number
          new_row: Json | null
          old_row: Json | null
          reason: string | null
          time_entry_id: string
        }
        Insert: {
          action: string
          actor?: string | null
          happened_at?: string
          id?: never
          new_row?: Json | null
          old_row?: Json | null
          reason?: string | null
          time_entry_id: string
        }
        Update: {
          action?: string
          actor?: string | null
          happened_at?: string
          id?: never
          new_row?: Json | null
          old_row?: Json | null
          reason?: string | null
          time_entry_id?: string
        }
        Relationships: []
      }
      day_off_requests: {
        Row: {
          absence_date: string
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          deny_reason: string | null
          id: string
          kind: string
          reason: string | null
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          user_id: string
        }
        Insert: {
          absence_date: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          deny_reason?: string | null
          id?: string
          kind: string
          reason?: string | null
          requested_by: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id: string
        }
        Update: {
          absence_date?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          deny_reason?: string | null
          id?: string
          kind?: string
          reason?: string | null
          requested_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      ooh_processed_reports: {
        Row: {
          board_id: string | null
          form_item_id: string
          outcome: string | null
          processed_at: string
          target_item_id: string | null
          trigger_uuid: string | null
        }
        Insert: {
          board_id?: string | null
          form_item_id: string
          outcome?: string | null
          processed_at?: string
          target_item_id?: string | null
          trigger_uuid?: string | null
        }
        Update: {
          board_id?: string | null
          form_item_id?: string
          outcome?: string | null
          processed_at?: string
          target_item_id?: string | null
          trigger_uuid?: string | null
        }
        Relationships: []
      }
      ooh_report_queue: {
        Row: {
          board_id: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          details_line: string | null
          error: string | null
          form_item_id: string
          id: string
          lead_id: string | null
          office: string | null
          on_block: number | null
          partner: string | null
          plan: Json | null
          raw: Json | null
          reason: string | null
          rep_name: string | null
          result: number | null
          status: string
          target_item_id: string | null
          updated_at: string
        }
        Insert: {
          board_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          details_line?: string | null
          error?: string | null
          form_item_id: string
          id?: string
          lead_id?: string | null
          office?: string | null
          on_block?: number | null
          partner?: string | null
          plan?: Json | null
          raw?: Json | null
          reason?: string | null
          rep_name?: string | null
          result?: number | null
          status?: string
          target_item_id?: string | null
          updated_at?: string
        }
        Update: {
          board_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          details_line?: string | null
          error?: string | null
          form_item_id?: string
          id?: string
          lead_id?: string | null
          office?: string | null
          on_block?: number | null
          partner?: string | null
          plan?: Json | null
          raw?: Json | null
          reason?: string | null
          rep_name?: string | null
          result?: number | null
          status?: string
          target_item_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      nightly_approvals: {
        Row: {
          applied_at: string | null
          approvals_item_id: string
          block_board_id: string
          block_item_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          lead_date: string | null
          lead_name: string | null
          office: string | null
          proposed_add_names: string[]
          reason: string | null
          result_note: string | null
          snapshot_rep_names: string[]
          snapshot_statuses: Json | null
          state: string
        }
        Insert: {
          applied_at?: string | null
          approvals_item_id: string
          block_board_id: string
          block_item_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          lead_date?: string | null
          lead_name?: string | null
          office?: string | null
          proposed_add_names?: string[]
          reason?: string | null
          result_note?: string | null
          snapshot_rep_names?: string[]
          snapshot_statuses?: Json | null
          state?: string
        }
        Update: {
          applied_at?: string | null
          approvals_item_id?: string
          block_board_id?: string
          block_item_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          lead_date?: string | null
          lead_name?: string | null
          office?: string | null
          proposed_add_names?: string[]
          reason?: string | null
          result_note?: string | null
          snapshot_rep_names?: string[]
          snapshot_statuses?: Json | null
          state?: string
        }
        Relationships: []
      }
      ooh_dispatch_writes: {
        Row: {
          actor: string
          board_id: string | null
          column_id: string
          column_label: string | null
          created_at: string
          form_item_id: string | null
          id: string
          item_id: string
          lead_name: string | null
          mode: string
          new_value: string | null
          old_value: string | null
          reason: string | null
          trigger: string | null
        }
        Insert: {
          actor?: string
          board_id?: string | null
          column_id: string
          column_label?: string | null
          created_at?: string
          form_item_id?: string | null
          id?: string
          item_id: string
          lead_name?: string | null
          mode: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
          trigger?: string | null
        }
        Update: {
          actor?: string
          board_id?: string | null
          column_id?: string
          column_label?: string | null
          created_at?: string
          form_item_id?: string | null
          id?: string
          item_id?: string
          lead_name?: string | null
          mode?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
          trigger?: string | null
        }
        Relationships: []
      }
      attendance_overrides: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          office: string
          override_date: string
          rep_key: string
          rep_name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          office: string
          override_date: string
          rep_key: string
          rep_name: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          office?: string
          override_date?: string
          rep_key?: string
          rep_name?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      respawn_requests: {
        Row: {
          approved_shifts: string[] | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          id: string
          late: boolean
          monday_item_id: string | null
          office: string
          reason: string | null
          rep_name: string
          shifts: string[]
          status: string
          updated_at: string
          user_id: string
          week_start: string
        }
        Insert: {
          approved_shifts?: string[] | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          id?: string
          late?: boolean
          monday_item_id?: string | null
          office: string
          reason?: string | null
          rep_name: string
          shifts?: string[]
          status?: string
          updated_at?: string
          user_id: string
          week_start: string
        }
        Update: {
          approved_shifts?: string[] | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          id?: string
          late?: boolean
          monday_item_id?: string | null
          office?: string
          reason?: string | null
          rep_name?: string
          shifts?: string[]
          status?: string
          updated_at?: string
          user_id?: string
          week_start?: string
        }
        Relationships: []
      }
      time_week_attestations: {
        Row: {
          created_at: string
          hours_at_attestation: number | null
          id: string
          note: string | null
          status: string
          superseded_at: string | null
          user_id: string
          week_start: string
        }
        Insert: {
          created_at?: string
          hours_at_attestation?: number | null
          id?: string
          note?: string | null
          status: string
          superseded_at?: string | null
          user_id: string
          week_start: string
        }
        Update: {
          created_at?: string
          hours_at_attestation?: number | null
          id?: string
          note?: string | null
          status?: string
          superseded_at?: string | null
          user_id?: string
          week_start?: string
        }
        Relationships: []
      }
      turf_assignment_history: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          assigned_user_id: string | null
          id: string
          turf_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          assigned_user_id?: string | null
          id?: string
          turf_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          assigned_user_id?: string | null
          id?: string
          turf_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "turf_assignment_history_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turf_assignment_history_assigned_user_id_fkey"
            columns: ["assigned_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turf_assignment_history_turf_id_fkey"
            columns: ["turf_id"]
            isOneToOne: false
            referencedRelation: "turfs"
            referencedColumns: ["id"]
          },
        ]
      }
      turfs: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          assigned_user_id: string | null
          color: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          notes: string | null
          polygon_coordinates: Json
          updated_at: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_user_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          notes?: string | null
          polygon_coordinates: Json
          updated_at?: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_user_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          notes?: string | null
          polygon_coordinates?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "turfs_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turfs_assigned_user_id_fkey"
            columns: ["assigned_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turfs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_logs: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          raw_payload: Json | null
          source: string | null
          step: string | null
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          raw_payload?: Json | null
          source?: string | null
          step?: string | null
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          raw_payload?: Json | null
          source?: string | null
          step?: string | null
        }
        Relationships: []
      }
      zip_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          captain_id: string
          created_at: string
          zip: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          captain_id: string
          created_at?: string
          zip: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          captain_id?: string
          created_at?: string
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "zip_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zip_assignments_captain_id_fkey"
            columns: ["captain_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      customer_homes: {
        Row: {
          address: string | null
          last_name: string | null
          lat: number | null
          lng: number | null
          monday_item_id: string | null
          office_location: string | null
          products: string | null
          sold_on: string | null
          source: string | null
        }
        Relationships: []
      }
      commission_clawback_outstanding: {
        Row: {
          canvasser_id: string | null
          customer_name: string | null
          direction: string | null
          display_name: string | null
          lead_id: string | null
          outstanding: number | null
          paid_commission: number | null
          paid_week: string | null
          recovered: number | null
          sale_amount: number | null
        }
        Relationships: []
      }
      timesheet_day_detail: {
        Row: {
          billable_hours: number | null
          clock_in: string | null
          clock_out: string | null
          display_name: string | null
          entry_source: string | null
          first_meal_start: string | null
          flag_reasons: string[] | null
          id: string | null
          last_meal_end: string | null
          log_date: string | null
          meal_count: number | null
          meal_minutes: number | null
          meal_status: string | null
          needs_correction: boolean | null
          reviewed_at: string | null
          reviewed_by: string | null
          second_meal_status: string | null
          team_name: string | null
          user_id: string | null
          void_reason: string | null
          voided_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      archive_agent: { Args: { _user_id: string }; Returns: undefined }
      auto_archive_agents: { Args: never; Returns: number }
      auto_clock_out_expired: { Args: never; Returns: number }
      admin_create_time_entry: {
        Args: {
          _user_id: string
          _clock_in: string
          _clock_out: string | null
          _reason: string
        }
        Returns: string
      }
      admin_set_meal: {
        Args: {
          _time_entry_id: string
          _meal_start: string
          _meal_end: string
          _reason: string
        }
        Returns: undefined
      }
      admin_update_time_entry: {
        Args: {
          _id: string
          _clock_in: string
          _clock_out: string | null
          _reason: string
        }
        Returns: undefined
      }
      approve_payroll_run: {
        Args: { _run_id: string }
        Returns: undefined
      }
      approve_time_entry: {
        Args: { _id: string }
        Returns: undefined
      }
      attest_week: {
        Args: { _week_start: string; _confirm: boolean; _note?: string | null }
        Returns: string
      }
      submit_day_off: {
        Args: { _user_id: string; _dates: string[]; _kind: string; _reason?: string | null }
        Returns: Json
      }
      review_day_off: {
        Args: { _id: string; _approve: boolean; _deny_reason?: string | null }
        Returns: undefined
      }
      cancel_day_off: {
        Args: { _id: string }
        Returns: undefined
      }
      reopen_payroll_run: {
        Args: { _run_id: string; _reason: string }
        Returns: undefined
      }
      calc_monthly_paycheck: {
        Args: { _canvasser_id: string; _month_start: string }
        Returns: {
          month_end: string
          month_start: string
          sale_price_total: number
          total_pay: number
          total_points: number
          total_sales: number
          total_sits: number
          volume_bonus: number
          volume_bonus_ot_true_up: number
          weekly_pay_total: number
        }[]
      }
      calc_weekly_paycheck: {
        Args: { _canvasser_id: string; _week_start: string }
        Returns: {
          base_pay: number
          commission: number
          commission_rate: number
          dt_hours: number
          exceptions: Json
          hourly_rate: number
          hours: number
          meal_premium_count: number
          meal_premium_pay: number
          monster_bonus: number
          ot_hours: number
          ot_premium_pay: number
          points: number
          rank: string
          reg_hours: number
          regular_rate: number
          sale_price_total: number
          sales: number
          sit_bonus: number
          sits: number
          total_pay: number
          week_end: string
          week_start: string
        }[]
      }
      create_payroll_run: {
        Args: { _week_start: string }
        Returns: string
      }
      crew_clock_in: {
        Args: { _user_ids: string[] }
        Returns: Json
      }
      crew_clock_out: {
        Args: { _user_ids: string[] }
        Returns: Json
      }
      crew_start_lunch: {
        Args: { _user_ids: string[] }
        Returns: Json
      }
      crew_end_lunch: {
        Args: { _user_ids: string[] }
        Returns: Json
      }
      evaluate_canvasser_suspension: {
        Args: { _canvasser_id: string }
        Returns: undefined
      }
      claim_roster_spot: { Args: never; Returns: Json }
      global_visibility_on: { Args: never; Returns: boolean }
      grant_time_clock_exception: {
        Args: {
          _user_id: string
          _date: string
          _early_from: string | null
          _late_until: string | null
          _reason: string
        }
        Returns: string
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      merge_canvassers: {
        Args: { _loser_ids: string[]; _keeper: string; _keep_name?: string }
        Returns: Json
      }
      my_team_id: { Args: { _user_id: string }; Returns: string }
      increment_leads_generated: {
        Args: { _canvasser_id: string; _metric_date: string; _office: string }
        Returns: undefined
      }
      prepare_profile_deletion: { Args: { _target: string }; Returns: undefined }
      reactivate_agent: { Args: { _user_id: string }; Returns: undefined }
      real_owner_count: { Args: never; Returns: number }
      rename_canvasser: {
        Args: { _ids: string[]; _new_name: string }
        Returns: Json
      }
      refresh_canvasser_rank: {
        Args: { _canvasser_id: string }
        Returns: string
      }
      revoke_time_clock_exception: {
        Args: { _id: string }
        Returns: undefined
      }
      set_user_role: {
        Args: {
          _new_role: Database["public"]["Enums"]["app_role"]
          _target_user: string
        }
        Returns: undefined
      }
      void_time_entry: {
        Args: { _id: string; _reason: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "owner"
        | "captain"
        | "canvasser"
        | "office_staff"
        | "sales_rep"
        | "confirmer"
        | "bookkeeper"
      canvasser_status:
        | "active"
        | "suspended"
        | "inactive"
        | "suspension_review"
      lead_status: "pending" | "confirmed" | "denied"
      pin_type:
        | "not_home"
        | "talked_to"
        | "lead"
        | "knock"
        | "not_interested"
        | "renter"
        | "appt"
        | "go_back"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "owner",
        "captain",
        "canvasser",
        "office_staff",
        "sales_rep",
        "confirmer",
        "bookkeeper",
      ],
      canvasser_status: [
        "active",
        "suspended",
        "inactive",
        "suspension_review",
      ],
      lead_status: ["pending", "confirmed", "denied"],
      pin_type: [
        "not_home",
        "talked_to",
        "lead",
        "knock",
        "not_interested",
        "renter",
        "appt",
        "go_back",
      ],
    },
  },
} as const
